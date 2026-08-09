import { mkdir, writeFile } from 'node:fs/promises';

import { generatedDir, generateContractTypes } from './contract-generation.mjs';

await mkdir(generatedDir, { recursive: true });

const { apiTypes, eventTypes } = await generateContractTypes();
await writeFile(new URL('api.ts', generatedDir), apiTypes);
await writeFile(new URL('room-events.ts', generatedDir), eventTypes);
