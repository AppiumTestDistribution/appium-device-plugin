/* eslint-disable no-prototype-builtins */
import 'reflect-metadata';
import commands from './commands/index';
import BasePlugin from '@appium/base-plugin';
import { router } from './app';
import { IDevice } from './interfaces/IDevice';
import { ISessionCapability } from './interfaces/ISessionCapability';
import AsyncLock from 'async-lock';
import {
  setSimulatorState,
  unblockDeviceMatchingFilter,
  updatedAllocatedDevice,
} from './data-service/device-service';
import {
  addNewPendingSession,
  removePendingSession,
} from './data-service/pending-sessions-service';
import {
  allocateDeviceForSession,
  setupCronReleaseBlockedDevices,
  setupCronUpdateDeviceList,
  deviceType,
  initializeStorage,
  isIOS,
  refreshSimulatorState,
  setupCronCheckStaleDevices,
  updateDeviceList,
  setupCronCleanPendingSessions,
} from './device-utils';
import { DeviceFarmManager } from './device-managers';
import { Container } from 'typedi';
import log from './logger';
import { v4 as uuidv4 } from 'uuid';
import axios, { AxiosError } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { nodeUrl, spinWith, stripAppiumPrefixes, isDeviceFarmRunning } from './helpers';
import { addProxyHandler, registerProxyMiddlware } from './wd-command-proxy';
import ChromeDriverManager from './device-managers/ChromeDriverManager';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { addCLIArgs } from './data-service/pluginArgs';
import Cloud from './enums/Cloud';
import ip from 'ip';
import _ from 'lodash';
import { ADB } from 'appium-adb';
import { DefaultPluginArgs, IPluginArgs } from './interfaces/IPluginArgs';
import NodeDevices from './device-managers/NodeDevices';
import { IDeviceFilterOptions } from './interfaces/IDeviceFilterOptions';

const commandsQueueGuard = new AsyncLock();
const DEVICE_MANAGER_LOCK_NAME = 'DeviceManager';
let platform: any;
let androidDeviceType: any;
let iosDeviceType: any;
let hasEmulators: any;
let proxy: any;

class DevicePlugin extends BasePlugin {
  private pluginArgs: IPluginArgs = DefaultPluginArgs;
  constructor(pluginName: string, cliArgs: any) {
    super(pluginName, cliArgs);
    // initialize plugin args only when cliArgs.plugin['device-farm'] is present
    if (cliArgs.plugin && cliArgs.plugin['device-farm'])
      Object.assign(this.pluginArgs, cliArgs.plugin['device-farm'] as unknown as IPluginArgs);
  }

  onUnexpectedShutdown(driver: any, cause: any) {
    const deviceFilter = {
      session_id: driver.sessionId ? driver.sessionId : undefined,
      udid: driver.caps && driver.caps.udid ? driver.caps.udid : undefined,
    } as unknown as IDeviceFilterOptions;

    if (this.pluginArgs.hub !== undefined) {
      // send unblock request to hub. Should we unblock the whole devices from this node?
      (new NodeDevices(this.pluginArgs.hub)).unblockDevice(deviceFilter);
    } else {
      unblockDeviceMatchingFilter(deviceFilter);
    }
    
    log.info(
      `Unblocking device mapped with filter ${JSON.stringify(
        deviceFilter,
      )} onUnexpectedShutdown from server`,
    );
  }

  public static async updateServer(expressApp: any, httpServer: any, cliArgs: any): Promise<void> {
    const pluginArgs: IPluginArgs = Object.assign(
      {},
      DefaultPluginArgs,
      cliArgs.plugin['device-farm'] as IPluginArgs,
    );

    platform = pluginArgs.platform;
    androidDeviceType = pluginArgs.androidDeviceType;
    iosDeviceType = pluginArgs.iosDeviceType;
    if (pluginArgs.proxy !== undefined) {
      log.info(`Adding proxy for axios: ${JSON.stringify(pluginArgs.proxy)}`);
      proxy = pluginArgs.proxy;
    } else {
      log.info('proxy is not required for axios');
    }
    hasEmulators = pluginArgs.emulators && pluginArgs.emulators.length > 0;

    expressApp.use('/device-farm', router);
    registerProxyMiddlware(expressApp);

    if (!platform)
      throw new Error(
        '🔴 🔴 🔴 Specify --plugin-device-farm-platform from CLI as android,iOS or both or use appium server config. Please refer 🔗 https://github.com/appium/appium/blob/master/packages/appium/docs/en/guides/config.md 🔴 🔴 🔴',
      );

    if (hasEmulators && pluginArgs.platform.toLowerCase() === 'android') {
      log.info('Emulators will be booted!!');
      const adb = await ADB.createADB({});
      const array = pluginArgs.emulators || [];
      const promiseArray = array.map(async (arr: any) => {
        await Promise.all([await adb.launchAVD(arr.avdName, arr)]);
      });
      await Promise.all(promiseArray);
    }

    const chromeDriverManager =
      pluginArgs.skipChromeDownload === false
        ? await ChromeDriverManager.getInstance()
        : undefined;
    iosDeviceType = DevicePlugin.setIncludeSimulatorState(cliArgs, iosDeviceType);
    const deviceTypes = { androidDeviceType, iosDeviceType };
    const deviceManager = new DeviceFarmManager(
      platform,
      deviceTypes,
      cliArgs.port,
      pluginArgs
    );
    Container.set(DeviceFarmManager, deviceManager);
    if (chromeDriverManager) Container.set(ChromeDriverManager, chromeDriverManager);

    await addCLIArgs(cliArgs);
    await initializeStorage();

    log.info(
      `📣📣📣 Device Farm Plugin will be served at 🔗 http://localhost:${cliArgs.port}/device-farm`,
    );

    const hubArgument = pluginArgs.hub;

    if (hubArgument) {
      await DevicePlugin.waitForRemoteDeviceFarmToBeRunning(hubArgument);
    }

    const devicesUpdates = await updateDeviceList(hubArgument);
    if (isIOS(pluginArgs) && deviceType(pluginArgs, 'simulated')) {
      await setSimulatorState(devicesUpdates);
      await refreshSimulatorState(pluginArgs, cliArgs.port);
    }

    if (hubArgument) {
      // hub may have been restarted, so let's send device list regularly
      await setupCronUpdateDeviceList(hubArgument, pluginArgs.sendNodeDevicesToHubIntervalMs);
    } else {
      // I'm a hub so let's:
      // check for stale nodes
      await setupCronCheckStaleDevices(pluginArgs.checkStaleDevicesIntervalMs);
      // and release blocked devices
      await setupCronReleaseBlockedDevices(pluginArgs.checkBlockedDevicesIntervalMs, pluginArgs.newCommandTimeoutSec);
      // and clean up pending sessions 
      await setupCronCleanPendingSessions(pluginArgs.checkBlockedDevicesIntervalMs, pluginArgs.deviceAvailabilityTimeoutMs + 10000);
    }
  }

  private static setIncludeSimulatorState(pluginArgs: IPluginArgs, deviceTypes: string) {
    if (pluginArgs.cloud !== undefined) {
      deviceTypes = 'real';
      log.info('ℹ️ Skipping Simulators as per the configuration ℹ️');
    }
    return deviceTypes;
  }

  static async waitForRemoteDeviceFarmToBeRunning(host: string) {
    await spinWith(
      `Waiting for node server ${host} to be up and running\n`,
      async () => {
        await isDeviceFarmRunning(host);
      },
      (msg: any) => {
        throw new Error(`Failed: ${msg}`);
      },
    );
  }

  async createSession(
    next: () => any,
    driver: any,
    jwpDesCaps: any,
    jwpReqCaps: any,
    caps: ISessionCapability,
  ) {
    const pendingSessionId = uuidv4();
    log.debug(`📱 Creating temporary session id: ${pendingSessionId}`)
    const {
      alwaysMatch: requiredCaps = {}, // If 'requiredCaps' is undefined, set it to an empty JSON object (#2.1)
      firstMatch: allFirstMatchCaps = [{}], // If 'firstMatch' is undefined set it to a singleton list with one empty object (#3.1)
    } = caps;
    stripAppiumPrefixes(requiredCaps);
    stripAppiumPrefixes(allFirstMatchCaps);
    await addNewPendingSession({
      ...Object.assign({}, caps.firstMatch[0], caps.alwaysMatch),
      capability_id: pendingSessionId,
      // mark the insertion date
      createdAt: new Date().getTime(),
    });

    /**
     *  Wait untill a free device is available for the given capabilities
     */
    const device = await commandsQueueGuard.acquire(
      DEVICE_MANAGER_LOCK_NAME,
      async (): Promise<IDevice> => {
        //await refreshDeviceList();
        try {
          return await allocateDeviceForSession(
            caps, 
            this.pluginArgs.deviceAvailabilityTimeoutMs,
            this.pluginArgs.deviceAvailabilityQueryIntervalMs,
            this.pluginArgs
          );
        } catch (err) {
          await removePendingSession(pendingSessionId);
          throw err;
        }
      },
    );

    let session;

    if (!device.host.includes(ip.address())) {
      session = await this.forwardSessionRequest(device, caps)
    } else {
      session = await next();
    }

    await removePendingSession(pendingSessionId);

    if (session.error) {
      await updatedAllocatedDevice(device, { busy: false });
      log.info(`📱 Device UDID ${device.udid} unblocked. Reason: Session failed to create`);
    } else {
      log.info(`📱 Device UDID ${device.udid} blocked for session ${session.value[0]}`);
      const sessionId = session.value[0];
      await updatedAllocatedDevice(device, {
        busy: true,
        session_id: sessionId,
        lastCmdExecutedAt: new Date().getTime(),
        sessionStartTime: new Date().getTime(),
      });
      if (!device.host.includes(ip.address())) {
        addProxyHandler(sessionId, device.host);
      }
      log.info(`📱 Updating Device ${device.udid} with session ID ${sessionId}`);
    }
    return session;
  }

  private async forwardSessionRequest(device: IDevice, caps: ISessionCapability): Promise<{ protocol: string; value: string[]; }> {
    const remoteUrl = nodeUrl(device);
    let capabilitiesToCreateSession = { capabilities: caps };
    if (device.hasOwnProperty('cloud') && device.cloud.toLowerCase() === Cloud.LAMBDATEST) {
      capabilitiesToCreateSession = Object.assign(capabilitiesToCreateSession, {
        desiredCapabilities: capabilitiesToCreateSession.capabilities.alwaysMatch,
      });
    }
    // need to sanitize to remove sensitive information
    // log.debug(`Remote Host URL - ${remoteUrl}`);
    let sessionDetails: any;
    log.info(
      `Creating cloud session with desiredCapabilities: "${JSON.stringify(
        capabilitiesToCreateSession
      )}"`
    );
    const config: any = {
      method: 'post',
      url: remoteUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      data: capabilitiesToCreateSession,
    };
    //log.info(`Add proxy to axios config only if it is set: ${JSON.stringify(proxy)}`);
    if (proxy != undefined) {
      log.info(`Added proxy to axios config: ${JSON.stringify(proxy)}`);
      config.httpsAgent = new HttpsProxyAgent(proxy);
      config.httpAgent = new HttpProxyAgent(proxy);
      config.proxy = false;
    }

    log.info(`With axios config: "${JSON.stringify(config)}"`);
    try {
      const response = await axios(config);
      sessionDetails = response.data;
      if (Object.hasOwn(sessionDetails.value, 'error')) {
        log.error(`Error while creating session: ${sessionDetails.value.error}`);
        this.unblockDeviceOnError(device, sessionDetails.value.error);
      }
    } catch (error: AxiosError<any> | any) {
      let errorMessage = '';
      if (error instanceof AxiosError) {
        log.error(`Error while creating session: ${JSON.stringify(error.response?.data)}`);
        errorMessage = JSON.stringify(error.response?.data);
      } else {
        log.error(`Error while creating session: ${error}`);
        errorMessage = error;
      }
      if (error != undefined) this.unblockDeviceOnError(device, errorMessage);
    }

    log.debug(`📱 Session received with details: ${JSON.stringify(sessionDetails)}`);

    return {
      protocol: 'W3C',
      value: [sessionDetails.value.sessionId, sessionDetails.value.capabilities, 'W3C'],
    };
  }

  private unblockDeviceOnError(device: IDevice, error: any) {
    updatedAllocatedDevice(device, { busy: false });
    log.warn(
      `📱 Device UDID ${device.udid} unblocked. Reason: Remote Session failed to create. "${error}"`,
    );
  }

  async deleteSession(next: () => any, driver: any, sessionId: any) {
    unblockDeviceMatchingFilter({ session_id: sessionId });
    log.info(`📱 Unblocking the device that is blocked for session ${sessionId}`);
    return await next();
  }
}

Object.assign(DevicePlugin.prototype, commands);
export { DevicePlugin };
