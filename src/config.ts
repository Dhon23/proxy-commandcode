import { z } from 'zod'

const envSchema = z.object({
  PCMC_PORT: z.coerce.number().int().default(3456),
  PCMC_VERSION: z.string().default('0.41.1'),
  PCMC_ENV: z.string().default('production'),
  PCMC_RATE_LIMIT_RPM: z.coerce.number().int().default(15),
  PCMC_RATE_LIMIT_TPM: z.coerce.number().int().default(600000),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
  console.error(`Invalid environment variables:\n${issues}`)
  process.exit(1)
}

const env = parsed.data

export const config = {
  port: env.PCMC_PORT,
  host: 'api.commandcode.ai',
  path: '/alpha/generate',
  ccVersion: env.PCMC_VERSION,
  environment: env.PCMC_ENV,
  rateLimit: {
    rpm: env.PCMC_RATE_LIMIT_RPM,
    tpm: env.PCMC_RATE_LIMIT_TPM,
  },
  staticConfig: {
    workingDir: '',
    date: new Date().toISOString().slice(0, 10),
    environment: env.PCMC_ENV,
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
