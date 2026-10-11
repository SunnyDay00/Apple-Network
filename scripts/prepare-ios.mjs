import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function cap(...args) {
  const result = spawnSync(process.execPath, [resolve('node_modules/@capacitor/cli/bin/capacitor'), ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync('dist/index.html')) throw new Error('请先执行 npm run build。');
if (!existsSync('ios/App/App.xcodeproj')) cap('add', 'ios', '--packagemanager', 'SPM');
cap('sync', 'ios');

// Capacitor discovers @objc plugins from the local npm package and adds them to
// both its SPM dependency graph and runtime registration list. Fail if either is missing.
const registration = JSON.parse(readFileSync('ios/App/App/capacitor.config.json', 'utf8'));
if (!registration.packageClassList?.includes('NetworkProbePlugin')) throw new Error('原生插件未被 Capacitor 注册，停止构建。');
const manifest = readFileSync('ios/App/CapApp-SPM/Package.swift', 'utf8');
if (!manifest.includes('.product(name: "AppleNetworkNetworkProbe"')) throw new Error('Swift 插件未加入 SPM 编译依赖。');
const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-X', 'utf8', 'scripts/configure_ios.py'], { stdio: 'inherit' });
if (python.error) throw python.error;
if (python.status !== 0) process.exit(python.status ?? 1);
console.log('iOS 工程、Swift 包引用及运行时插件注册已准备。');
