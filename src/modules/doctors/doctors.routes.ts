import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requestCtx } from '../../plugins/types.js';
import { UuidParam, errorResponses } from '../common/schemas.js';
import {
  DoctorSchema,
  SearchDoctorsQuery,
  SearchDoctorsResponse,
  UpsertDoctorProfileBody,
} from './doctors.schemas.js';
import type { DoctorsService } from './doctors.service.js';

export const doctorsRoutes =
  ({ doctors }: { doctors: DoctorsService }): FastifyPluginAsyncZod =>
  async (app) => {
    const tags = ['Doctors'];

    app.get(
      '/',
      {
        config: { public: true },
        schema: {
          tags,
          summary: 'Search & filter verified doctors (cached, keyset-paginated)',
          querystring: SearchDoctorsQuery,
          response: { 200: SearchDoctorsResponse, ...errorResponses },
        },
      },
      async (req) => doctors.search(req.query),
    );

    app.put(
      '/me',
      {
        config: { permission: 'doctor_profile:manage_own' },
        schema: {
          tags,
          security: [{ bearerAuth: [] }],
          summary: 'Create or update own doctor profile (admin verification required to be listed)',
          body: UpsertDoctorProfileBody,
          response: { 200: DoctorSchema, ...errorResponses },
        },
      },
      async (req) => doctors.upsertOwnProfile(req.actor!.id, req.body, requestCtx(req)),
    );

    app.get(
      '/me',
      {
        config: { permission: 'doctor_profile:manage_own' },
        schema: {
          tags,
          security: [{ bearerAuth: [] }],
          summary: 'Own doctor profile',
          response: { 200: DoctorSchema, ...errorResponses },
        },
      },
      async (req) => doctors.getById(req.actor!.id, { includeUnverified: true, fresh: true }),
    );

    app.get(
      '/:id',
      {
        config: { public: true },
        schema: {
          tags,
          summary: 'Public doctor profile',
          params: UuidParam,
          response: { 200: DoctorSchema, ...errorResponses },
        },
      },
      async (req) => doctors.getById(req.params.id),
    );
  };
