"""Build real-device .app/IPA on a macOS runner. Never log signing credentials."""
from pathlib import Path
import argparse
import base64
import contextlib
import datetime
import hashlib
import json
import os
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'build'
OUTPUT = ROOT / 'artifacts'
BUNDLE_ID = 'cn.goodbye.applenetworkprobe'


def logged(args, name):
    log = BUILD / 'logs' / f'{name}.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('w', encoding='utf-8', newline='\n') as stream:
        proc = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
        for line in proc.stdout:
            stream.write(line)
            print(line, end='', flush=True)
        code = proc.wait()
    if code:
        raise RuntimeError(f'{name} 失败，退出码 {code}，完整日志：{log}')


def private_command(args, operation):
    # Exceptions and CI logs never include secret-containing arguments.
    proc = subprocess.run(args, capture_output=True, check=False)
    if proc.returncode:
        raise RuntimeError(f'{operation} 失败，退出码 {proc.returncode}。请检查签名 Secrets 和证书。')
    return proc.stdout


@contextlib.contextmanager
def signing_credentials(method):
    secrets = [os.environ.get(k, '') for k in ['IOS_CERTIFICATE_BASE64', 'IOS_CERTIFICATE_PASSWORD', 'IOS_PROFILE_BASE64']]
    if not secrets[0] or not secrets[2]:
        raise RuntimeError('需要 IOS_CERTIFICATE_BASE64、IOS_CERTIFICATE_PASSWORD、IOS_PROFILE_BASE64。')
    old_keychains = shlex.split(private_command(['security', 'list-keychains', '-d', 'user'], '读取钥匙串').decode())
    profile_path = None
    with tempfile.TemporaryDirectory(prefix='network-probe-sign-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        temporary = Path(directory)
        cert = temporary / 'certificate.p12'
        profile = temporary / 'profile.mobileprovision'
        keychain = temporary / 'build.keychain-db'
        keychain_password = uuid.uuid4().hex
        try:
            cert.write_bytes(base64.b64decode(secrets[0], validate=True))
            profile.write_bytes(base64.b64decode(secrets[2], validate=True))
            parsed = plistlib.loads(private_command(['security', 'cms', '-D', '-i', str(profile)], '解码描述文件'))
            if parsed['ExpirationDate'].replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc):
                raise RuntimeError('Provisioning Profile 已过期。')
            team = parsed['TeamIdentifier'][0]
            app_id = parsed['Entitlements'].get('application-identifier', '')
            if app_id not in [f'{team}.{BUNDLE_ID}', f'{team}.*']:
                raise RuntimeError(f'Profile 需要匹配 Bundle ID：{BUNDLE_ID}。')
            if method == 'release-testing' and not parsed.get('ProvisionedDevices'):
                raise RuntimeError('Ad Hoc 安装需要包含目标 iPhone UDID 的 Profile。')
            if method == 'debugging' and not parsed['Entitlements'].get('get-task-allow'):
                raise RuntimeError('debugging 导出需要 Development Profile。')
            profile_uuid = str(uuid.UUID(parsed['UUID'])).upper()
            profile_path = Path.home() / 'Library/MobileDevice/Provisioning Profiles' / f'{profile_uuid}.mobileprovision'
            profile_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(profile, profile_path)
            private_command(['security', 'create-keychain', '-p', keychain_password, str(keychain)], '创建临时钥匙串')
            private_command(['security', 'set-keychain-settings', '-lut', '21600', str(keychain)], '配置钥匙串')
            private_command(['security', 'unlock-keychain', '-p', keychain_password, str(keychain)], '解锁钥匙串')
            private_command(['security', 'import', str(cert), '-P', secrets[1], '-A', '-t', 'cert', '-f', 'pkcs12', '-k', str(keychain)], '导入签名证书')
            private_command(['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', keychain_password, str(keychain)], '授权签名工具')
            private_command(['security', 'list-keychains', '-d', 'user', '-s', str(keychain), *old_keychains], '启用签名钥匙串')
            identities = private_command(['security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)], '检查签名身份').decode()
            matching = [hashlib.sha1(c).hexdigest().upper() for c in parsed.get('DeveloperCertificates', [])]
            identity = next((c for c in matching if c in identities), None)
            if not identity:
                raise RuntimeError('P12 中的有效签名证书与 Profile 不匹配，或缺少私钥。')
            yield {'team': team, 'profile_uuid': profile_uuid, 'identity': identity, 'keychain': str(keychain)}
        finally:
            if old_keychains:
                subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *old_keychains], capture_output=True)
            subprocess.run(['security', 'delete-keychain', str(keychain)], capture_output=True)
            if profile_path:
                profile_path.unlink(missing_ok=True)


def unsigned():
    logged(['xcodebuild', '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
            '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-derivedDataPath', str(BUILD / 'unsigned'),
            'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=',
            'CURRENT_PROJECT_VERSION=' + os.environ.get('GITHUB_RUN_NUMBER', '1'), 'build'], 'unsigned-build')
    app = BUILD / 'unsigned/Build/Products/Release-iphoneos/App.app'
    if not app.is_dir():
        raise RuntimeError('编译结束但未找到真机 App.app，不能打包 IPA。')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    architecture = subprocess.check_output(['lipo', '-info', str(app / info['CFBundleExecutable'])], text=True)
    if 'arm64' not in architecture or info.get('DTPlatformName') != 'iphoneos':
        raise RuntimeError('产物并非 arm64 iPhone 真机应用。')
    registration = json.loads((app / 'capacitor.config.json').read_text(encoding='utf-8'))
    if 'NetworkProbePlugin' not in registration.get('packageClassList', []):
        raise RuntimeError('最终 App 缺少 Swift 插件注册。')
    # Check the compiled executable/frameworks actually contain the Objective-C plugin class.
    binary_files = [app / info['CFBundleExecutable']] + list((app / 'Frameworks').glob('*/*.framework'))
    for framework in (app / 'Frameworks').glob('*.framework'):
        if (framework / framework.stem).is_file():
            binary_files.append(framework / framework.stem)
    if not any(b'NetworkProbePlugin' in p.read_bytes() for p in binary_files if p.is_file()):
        raise RuntimeError('最终二进制未包含 NetworkProbePlugin，停止上传。')
    payload = BUILD / 'package/Payload'
    payload.mkdir(parents=True, exist_ok=True)
    destination = payload / 'AppleNetworkProbe.app'
    if destination.exists():
        shutil.rmtree(destination)  # fixed build-owned path
    shutil.copytree(app, destination, symlinks=True)
    private_command(['ditto', '-c', '-k', '--keepParent', str(payload), str(OUTPUT / 'AppleNetworkProbe-unsigned.ipa')], '打包 IPA')
    private_command(['ditto', '-c', '-k', '--keepParent', str(destination), str(OUTPUT / 'AppleNetworkProbe.app.zip')], '打包 .app')
    (OUTPUT / 'BUILD-INFO.txt').write_text(
        f'Apple Network Probe\n版本：{info["CFBundleShortVersionString"]}\n提交：{os.environ.get("GITHUB_SHA", "local")}\n'
        '平台：arm64 iPhone 真机\n签名：未签名 IPA，个人签名后才能安装。\n'
        '已确认 Swift 插件编译符号和运行时注册；仍需实体 iPhone 验证 TCP / HTTPS / 网络切换。\n', encoding='utf-8', newline='\n')


def signed(method):
    with signing_credentials(method) as credentials:
        archive = BUILD / 'signed/AppleNetworkProbe.xcarchive'
        logged(['xcodebuild', '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
                '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-archivePath', str(archive),
                '-derivedDataPath', str(BUILD / 'signed/DerivedData'), 'CODE_SIGN_STYLE=Manual',
                f'DEVELOPMENT_TEAM={credentials["team"]}', f'PROVISIONING_PROFILE_SPECIFIER={credentials["profile_uuid"]}',
                f'CODE_SIGN_IDENTITY={credentials["identity"]}', 'CURRENT_PROJECT_VERSION=' + os.environ.get('GITHUB_RUN_NUMBER', '1'),
                'archive'], 'signed-archive')
        export_plist = BUILD / 'signed/ExportOptions.plist'
        export_plist.write_bytes(plistlib.dumps({
            'method': method, 'signingStyle': 'manual', 'teamID': credentials['team'],
            'signingCertificate': credentials['identity'], 'provisioningProfiles': {BUNDLE_ID: credentials['profile_uuid']},
            'stripSwiftSymbols': True, 'manageAppVersionAndBuildNumber': False,
        }))
        logged(['xcodebuild', '-exportArchive', '-archivePath', str(archive), '-exportPath', str(BUILD / 'signed/export'),
                '-exportOptionsPlist', str(export_plist)], 'signed-export')
        ipa = list((BUILD / 'signed/export').glob('*.ipa'))
        if len(ipa) != 1:
            raise RuntimeError('签名导出未生成唯一 IPA。')
        app = archive / 'Products/Applications/App.app'
        private_command(['codesign', '--verify', '--deep', '--strict', str(app)], '验证应用签名')
        shutil.copyfile(ipa[0], OUTPUT / 'AppleNetworkProbe-signed.ipa')


def main():
    if sys.platform != 'darwin':
        raise RuntimeError('请通过 GitHub Actions macOS Runner 执行 iOS 构建，Windows 不需要 Xcode。')
    args = argparse.ArgumentParser()
    args.add_argument('--signed', action='store_true')
    args.add_argument('--method', choices=['debugging', 'release-testing', 'app-store-connect'], default='release-testing')
    parsed = args.parse_args()
    OUTPUT.mkdir(exist_ok=True)
    if parsed.signed:
        signed(parsed.method)
    else:
        unsigned()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print subprocess argument arrays, which may contain credentials.
        print(f'::error::{error}', file=sys.stderr)
        sys.exit(1)
