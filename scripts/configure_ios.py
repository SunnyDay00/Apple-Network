"""Repeatable non-GUI configuration of Capacitor's generated iOS project."""
from pathlib import Path
import json
import plistlib
import re
import struct
import zlib


def icon_png(size=1024):
    # Code-native icon matching the app's existing pulse symbol. No external asset dependency.
    points = [(190, 512), (340, 512), (438, 260), (584, 764), (686, 512), (834, 512)]
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)  # PNG scanline filter
        for x in range(size):
            stroke = False
            for (ax, ay), (bx, by) in zip(points, points[1:]):
                t = max(0, min(1, ((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)))
                if (x-ax-t*(bx-ax))**2 + (y-ay-t*(by-ay))**2 < 26**2:
                    stroke = True
                    break
            blend = (x + y) / (2 * size)
            pixels.extend((255, 255, 255) if stroke else (int(48-25*blend), int(153-53*blend), int(255-23*blend)))
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(pixels))) + chunk(b'IEND', b'')


def configure():
    info = Path('ios/App/App/Info.plist')
    data = plistlib.loads(info.read_bytes())
    data.update({
        'CFBundleDevelopmentRegion': 'zh_CN',
        'CFBundleDisplayName': '苹果网络探针',
        'NSLocalNetworkUsageDescription': '仅在你选择本地网络目标时，用于测量该目标的连接耗时。',
        'ITSAppUsesNonExemptEncryption': False,
    })
    info.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_XML, sort_keys=False))
    project = Path('ios/App/App.xcodeproj/project.pbxproj')
    raw = project.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    text = raw.decode('utf-8').replace('\r\n', '\n')
    # Register Apple's required-reason API manifest as an actual Xcode resource.
    # The native network plugin itself is referenced through SPM, not loose source files.
    if 'PrivacyInfo.xcprivacy' not in text:
        insertions = [
            ('/* Begin PBXBuildFile section */', '/* Begin PBXBuildFile section */\n\t\tA11000000000000000000001 /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = A11000000000000000000002 /* PrivacyInfo.xcprivacy */; };'),
            ('/* Begin PBXFileReference section */', '/* Begin PBXFileReference section */\n\t\tA11000000000000000000002 /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };'),
        ]
        for old, new in insertions:
            if text.count(old) != 1:
                raise RuntimeError('Xcode 模板改变，无法加入隐私资源。')
            text = text.replace(old, new, 1)
        # The Capacitor template groups its assets with the Info.plist reference.
        match = re.search(r'(?m)^([ \t]*)([A-F0-9]+ /\* Info\.plist \*/,)$', text)
        if not match:
            raise RuntimeError('Xcode 模板改变，未找到 Info.plist 资源组。')
        text = text[:match.start()] + match.group(1) + 'A11000000000000000000002 /* PrivacyInfo.xcprivacy */,\n' + text[match.start():]
        anchor = '\t\t\t\t504EC30F1FED79650016851F /* Assets.xcassets in Resources */,'
        if text.count(anchor) != 1:
            raise RuntimeError('Xcode 模板改变，未找到 Assets 资源构建阶段。')
        text = text.replace(anchor, '\t\t\t\tA11000000000000000000001 /* PrivacyInfo.xcprivacy in Resources */,\n' + anchor, 1)
    version = json.loads(Path('package.json').read_text(encoding='utf-8'))['version']
    text, count = re.subn(r'MARKETING_VERSION = [^;]+;', f'MARKETING_VERSION = {version};', text)
    if count != 2:
        raise RuntimeError('Xcode 工程模板改变：未找到两个版本号配置。')
    project.write_bytes(text.replace('\n', newline).encode('utf-8'))
    Path('ios/App/App/PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({
        'NSPrivacyTracking': False,
        'NSPrivacyCollectedDataTypes': [],
        'NSPrivacyAccessedAPITypes': [
            {'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryUserDefaults', 'NSPrivacyAccessedAPITypeReasons': ['CA92.1']},
            {'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPITypeReasons': ['C617.1']},
            {'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryDiskSpace', 'NSPrivacyAccessedAPITypeReasons': ['E174.1']},
        ],
    }))
    appicon = Path('ios/App/App/Assets.xcassets/AppIcon.appiconset')
    (appicon / 'AppIcon-1024.png').write_bytes(icon_png())
    (appicon / 'Contents.json').write_text(json.dumps({
        'images': [{'filename': 'AppIcon-1024.png', 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'}],
        'info': {'author': 'Apple Network Probe', 'version': 1},
    }, indent=2) + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    configure()
