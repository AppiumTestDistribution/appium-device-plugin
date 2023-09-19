export const browserStackSchema = {
  $schema: 'http://json-schema.org/draft-07/schema',
  title: 'CloudConfig',
  type: 'object',
  required: ['cloudName', 'url', 'devices'],
  properties: {
    cloudName: {
      type: 'string',
      description: 'Name of cloud browserstack/sauce/lambdatest/pCloudy',
    },
    url: {
      type: 'string',
      description: 'Url of cloud',
    },
    devices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          deviceName: {
            type: 'string',
          },
          os_version: {
            type: 'string',
          },
          platform: {
            type: 'string',
          },
        },
        required: ['deviceName', 'os_version', 'platform'],
      },
    },
  },
};

export const sauceOrLambdaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema',
  title: 'CloudConfig',
  type: 'object',
  required: ['cloudName', 'url', 'devices'],
  properties: {
    cloudName: {
      type: 'string',
      description: 'sauce or lambdatest',
    },
    url: {
      type: 'string',
      description: 'Url of cloud',
    },
    devices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          deviceName: {
            type: 'string',
          },
          platformVersion: {
            type: 'string',
          },
          platform: {
            type: 'string',
          },
        },
        required: ['deviceName', 'platformVersion', 'platform'],
      },
    },
  },
};

export const pCloudySchema = {
  $schema: 'http://json-schema.org/draft-07/schema',
  title: 'CloudConfig',
  type: 'object',
  required: ['cloudName', 'url', 'devices'],
  properties: {
    cloudName: {
      type: 'string',
      description: 'pCloudy',
    },
    url: {
      type: 'string',
      description: 'Url of cloud',
    },
    devices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pCloudy_DeviceManufacturer: {
            type: 'string',
          },
          pCloudy_DeviceVersion: {
            type: 'string',
          },
          platform: {
            type: 'string',
          },
        },
        required: ['pCloudy_DeviceManufacturer', 'pCloudy_DeviceVersion', 'platform'],
      },
    },
  },
};

export const defaultSchema = {
  $schema: 'http://json-schema.org/draft-07/schema',
  title: 'CloudConfig',
  type: 'object',
  required: ['cloudName', 'url', 'devices'],
  properties: {
    cloudName: {
      type: 'string',
      description: 'pCloudy',
    },
    url: {
      type: 'string',
      description: 'Url of cloud',
    },
    devices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
          },
        },
        required: ['platform'],
      },
    },
  },
};
