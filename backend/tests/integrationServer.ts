import { config } from '../src/config.js';

const database = new URL(process.env.ORIGINVAULT_TEST_DATABASE_URL!);
config.postgresHost = database.hostname;
config.postgresPort = Number(database.port || 5432);
config.port = Number(process.env.ORIGINVAULT_TEST_PORT);
await import('../src/index.js');
