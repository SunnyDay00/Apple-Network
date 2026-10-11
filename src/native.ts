import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { NetworkStatus, ProbeResult } from './types';
interface NetworkProbePlugin {
  getNetworkStatus(): Promise<NetworkStatus>;
  tcp(options: { host: string; port: number; timeout: number }): Promise<ProbeResult>;
  https(options: { host: string; port: number; timeout: number }): Promise<ProbeResult>;
  cancel(options: { reason: string }): Promise<void>;
  addListener(event: 'networkChanged', listener: (status: NetworkStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: 'interrupted', listener: (data: { reason: string }) => void): Promise<PluginListenerHandle>;
}
export const isNative = Capacitor.getPlatform() === 'ios';
export const NetworkProbe = registerPlugin<NetworkProbePlugin>('NetworkProbe');
