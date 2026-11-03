#!/usr/bin/env node
import { runBuyback } from './buyback.js';
import { ConfigError, loadConfig } from './config.js';
import { createNearClient } from './near-client.js';

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), outcome: 'config_error', problems: error.problems }));
      return 2;
    }
    throw error;
  }
  const { exitCode } = await runBuyback({ config, client: createNearClient(config) });
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), outcome: 'crash', detail: String(error?.message ?? error) }));
    process.exitCode = 1;
  },
);
