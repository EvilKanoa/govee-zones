import path from 'node:path';

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export interface AppConfig {
  mqtt: {
    /** Broker URL built from MQTT_HOST/MQTT_PORT; undefined disables the bridge. */
    url?: string;
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
      url: brokerUrl(env.MQTT_HOST, env.MQTT_PORT),
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

/** MQTT_HOST may be a bare host (mqtt://host:MQTT_PORT) or a full URL (mqtt://, mqtts://, ws://). */
function brokerUrl(host: string | undefined, port: string | undefined) {
  if (!host) return undefined;
  if (host.includes('://')) return host;
  return `mqtt://${host}:${port || 1883}`;
}
