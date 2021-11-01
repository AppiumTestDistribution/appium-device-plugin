import eventEmitter from './events';
import AndroidDeviceManager from './AndroidDeviceManager';
import IOSDeviceManager from './IOSDeviceManager';
import log from './logger';
import schedule from 'node-schedule';
import SimulatorManager from './SimulatorManager';
import { isMac, checkIfPathIsAbsolute } from './helpers';
import { IDevice } from './interfaces/IDevice';
import { IOptions } from './interfaces/IOptions';
import {
  compose,
  propEq,
  curry,
  map,
  assoc,
  when,
  filter,
  concat,
  find,
} from 'ramda';
import logger from './logger';
import NodeCache from 'node-cache';
import { Platform } from './types/Platform';

const cache = new NodeCache();

let instance = false;
const simulatorManager = new SimulatorManager();
const androidDevices = new AndroidDeviceManager();
const iosDevices = new IOSDeviceManager();

export const emitConnectedDevices = () => {
  log.info('Starting & initializing the listen to device changes');
  const rule = new schedule.RecurrenceRule();
  rule.second = [0, 10, 20, 30, 40, 50];
  schedule.scheduleJob(rule, async function () {
    const androidDeviceManager = new AndroidDeviceManager();
    const iOSDeviceManager = new IOSDeviceManager();
    const connectedAndroidDevices: Array<IDevice> =
      await androidDeviceManager.getDevices();
    const connectedIOSDevices: Array<IDevice> =
      await iOSDeviceManager.getDevices();
    eventEmitter.emit('ConnectedDevices', {
      emittedDevices: Object.assign(
        connectedAndroidDevices,
        connectedIOSDevices
      ),
    });
  });
};

const isDeviceBusy = (device: IDevice) => device.busy;
const devicePlatForm = (device: IDevice) => device.platform.toLowerCase();
const alter = curry((state, udid, platform) => {
  const device: Array<IDevice> = cache.get(platform) as Array<IDevice>;
  const alteredDeviceMap = map(
    when(propEq('udid', udid), assoc('busy', state)),
    device
  );
  cache.set(platform, alteredDeviceMap);
});
const filterRealDevices = curry((isRealDevice: boolean, devices) =>
  filter(compose(propEq('realDevice', isRealDevice)))(devices)
);

export const getFreeDevice = (
  platform: Platform,
  options?: IOptions
): IDevice => {
  log.info(`Finding Free Device for Platform ${platform}`);

  const deviceState = (device: IDevice) => {
    return !isDeviceBusy(device) && platform.includes(devicePlatForm(device));
  };
  const device: Array<IDevice> = cache.get(platform) as Array<IDevice>;
  if (options) {
    return device.find(
      (device) =>
        deviceState.call(this, device) &&
        device.name.includes(options.simulator)
    ) as IDevice;
  } else {
    return device.find((device) => deviceState.call(this, device)) as IDevice;
  }
};

export const blockDevice = (freeDevice: IDevice, firstMatchPlatform: string) =>
  alter(true, freeDevice.udid, firstMatchPlatform);

export const unblockDevice = (
  blockedDevice: IDevice,
  firstMatchPlatform: string
) => alter(false, blockedDevice.udid, firstMatchPlatform);

export const updateDevice = (freeDevice: IDevice, sessionId?: string) => {
  const devices: Array<IDevice> = cache.get(
    freeDevice.platform //This will fail for ios
  ) as Array<IDevice>;
  logger.info(`Updating Device ${freeDevice.udid} with ${sessionId}`);
  const alteredDeviceMap = map(
    when(propEq('udid', freeDevice.udid), assoc('sessionId', sessionId)),
    devices
  );
  cache.set(freeDevice.platform, alteredDeviceMap);
};

export const getDeviceForSession = (sessionId: string): IDevice => {
  const device: any = cache.mget(['android', 'ios']);
  const mergedDevices = concat(device.android, device.ios);
  return find(propEq('sessionId', sessionId), mergedDevices) as IDevice;
};

export const fetchDevices = async () => {
  const udids = process.env.UDIDS;
  if (!instance) {
    log.info('Fetching all connected devices');
    let simulators: Array<IDevice>;
    let connectedIOSDevices: Array<IDevice>;
    let connectedAndroidDevices: Array<IDevice>;
    if (isMac()) {
      simulators = await simulatorManager.getSimulators();
      connectedIOSDevices = await iosDevices.getDevices();
      connectedAndroidDevices = await androidDevices.getDevices();
      if (udids) {
        fetchDevicesFromUDIDS(
          simulators,
          connectedAndroidDevices,
          connectedIOSDevices
        );
      } else {
        cache.mset([
          { key: 'android', val: connectedAndroidDevices },
          { key: 'ios', val: Object.assign(simulators, connectedIOSDevices) },
        ]);
        emitConnectedDevices();
      }
    } else {
      if (udids) {
        const userSpecifiedUDIDS = (process.env.UDIDS as string).split(',');
        const availableDevices = await androidDevices.getDevices();
        const filteredDevices = findUserSpecifiesDevices(
          userSpecifiedUDIDS,
          availableDevices
        );
        cache.set('userSpecifiedUDIDS', filteredDevices);
      } else {
        const android = await androidDevices.getDevices();
        cache.set('android', android);
        emitConnectedDevices();
      }
    }

    instance = true;
    /*   eventEmitter.on('ConnectedDevices', function (data) {
        const { emittedDevices } = data;
        emittedDevices.forEach((emittedDevice: IDevice) => {
          const allDevices: any = cache.mget([
            'android',
            'iOSSimulators',
            'iOSDevices',
          ]);
          allDevices.find((device: any) => device.udid === emittedDevice.udid);
          const deviceIndex = findIndex(
            propEq('udid', emittedDevices.udid),
            emittedDevices
          );
          emittedDevices[deviceIndex] = Object.assign({
            busy: !!actualDevice?.busy,
            state: emittedDevice.state,
            udid: emittedDevice.udid,
            sessionId: actualDevice?.sessionId ?? null,
            platform: emittedDevice.platform,
            realDevice: emittedDevice.realDevice,
            sdk: emittedDevice.sdk,
          });
        });
        remove(
          actualDevices,
          (device) =>
            device.platform === 'android' ||
            (device.platform === 'ios' && device.realDevice)
        );
        actualDevices.push(...emittedDevices);
      });*/
  }
};

export function isDeviceConfigPathAbsolute(path: string) {
  if (checkIfPathIsAbsolute(path)) {
    return true;
  } else {
    throw new Error(`Device Config Path ${path} should be absolute`);
  }
}

export function findUserSpecifiesDevices(
  userSpecifiedUDIDS: Array<string>,
  availableDevices: Array<IDevice>
) {
  const filteredDevices: Array<IDevice> = [];
  userSpecifiedUDIDS.forEach((value) =>
    filteredDevices.push(
      availableDevices.find((device) => device.udid === value) as IDevice
    )
  );
  return filteredDevices;
}

function fetchDevicesFromUDIDS(
  simulators: Array<IDevice>,
  connectedAndroidDevices: Array<IDevice>,
  connectedIOSDevices: Array<IDevice>
) {
  const userSpecifiedUDIDS: Array<string> = (process.env.UDIDS as string).split(
    ','
  );
  const availableDevices: Array<IDevice> = Object.assign(
    simulators,
    connectedAndroidDevices,
    connectedIOSDevices
  );
  const filteredDevices = findUserSpecifiesDevices(
    userSpecifiedUDIDS,
    availableDevices
  );
  cache.set('filteredDevices', filteredDevices);
}

export function listAllDevices() {
  return cache.mget(['android', 'iosSimulators', 'iosDevices']);
}

export function listAllAndroidDevices() {
  return cache.get('android');
}

export function cachedDevices() {
  return cache;
}

export function listiOSSimulators() {
  const allIOS = cache.get('ios');
  return filterRealDevices(false, allIOS);
}

export function listAlliOSDevices() {
  const allIOS = cache.get('ios');
  return filterRealDevices(true, allIOS);
}
