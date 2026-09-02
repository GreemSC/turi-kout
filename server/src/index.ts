import { resolve } from 'node:path';

import { buildApp, PUBLIC_DIR } from './app.ts';
import { DB_PATH } from './db.ts';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = await buildApp();
await app.listen({ port: PORT, host: HOST });
app.log.info(`base : ${resolve(DB_PATH)} — front : ${PUBLIC_DIR}`);
