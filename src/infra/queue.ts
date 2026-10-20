import { Queue, type JobsOptions, type RedisOptions } from 'bullmq';

export const QUEUES = {
  notifications: 'notifications',
  prescriptionPdf: 'prescription-pdf',
  payments: 'payments',
  maintenance: 'maintenance',
  deadLetter: 'dead-letter',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Every job retries with exponential backoff; exhausted jobs are copied to the DLQ by the worker. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export type Queues = Record<QueueName, Queue>;

export function createQueues(connection: RedisOptions, prefix = 'amrutam'): Queues {
  const make = (name: QueueName) =>
    new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return {
    notifications: make(QUEUES.notifications),
    'prescription-pdf': make(QUEUES.prescriptionPdf),
    payments: make(QUEUES.payments),
    maintenance: make(QUEUES.maintenance),
    'dead-letter': make(QUEUES.deadLetter),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}
