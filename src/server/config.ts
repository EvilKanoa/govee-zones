import path from 'node:path';

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export interface AppConfig {
  mqtt: {
    host?: string;
    port: number;
    username?: string;
    password?: string;
    discoveryPrefix: string;
    baseTopic: string;
  };
  webPort: number;
  dataDir: string;
  logLevel: string;
  simulate: boolean;
}

/** SPEC §2. MQTT_HOST is optional for now: without it the MQTT bridge is disabled. */
export function loadConfig(env = process.env): AppConfig {
  return {
    mqtt: {
      host: env.MQTT_HOST || undefined,
      port: Number(env.MQTT_PORT ?? 1883),
      username: env.MQTT_USERNAME || undefined,
      password: env.MQTT_PASSWORD || undefined,
      discoveryPrefix: env.MQTT_DISCOVERY_PREFIX ?? 'homeassistant',
      baseTopic: env.MQTT_BASE_TOPIC ?? 'govee-zones',
    },
    webPort: Number(env.WEB_PORT ?? 8080),
    dataDir: path.resolve(env.DATA_DIR ?? '/data'),
    logLevel: env.LOG_LEVEL ?? 'info',
    simulate: bool(env.SIMULATE, false),
  };
}
