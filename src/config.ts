import { z } from 'zod'

const envSchema = z.object({
  PCMC_PORT: z.coerce.number().int().default(3456),
  PCMC_VERSION: z.string().default('0.41.1'),
  PCMC_ENV: z.string().default('production'),
  PCMC_RATE_LIMIT_RPM: z.coerce.number().int().default(15),
  PCMC_RATE_LIMIT_TPM: z.coerce.number().int().default(600000),
})

const parsed = envSchema.parse(process.env)

export const config = {
  port: parsed.PCMC_PORT,
  host: 'api.commandcode.ai',
  path: '/alpha/generate',
  ccVersion: parsed.PCMC_VERSION,
  environment: parsed.PCMC_ENV,
  rateLimit: {
    rpm: parsed.PCMC_RATE_LIMIT_RPM,
    tpm: parsed.PCMC_RATE_LIMIT_TPM,
  },
  staticConfig: {
    workingDir: '',
    date: new Date().toISOString().slice(0, 10),
    environment: parsed.PCMC_ENV,
    structure: [] as string[],
    isGitRepo: false,
    currentBranch: '',
    mainBranch: 'main',
    gitStatus: '',
    recentCommits: [] as string[],
  },
  cors: {
    allowOrigin: '*',
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    maxAge: 86400,
  },
}

export type Config = typeof config
