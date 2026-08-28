"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result) __defProp(target, key, result);
  return result;
};
var __decorateParam = (index, decorator) => (target, key) => decorator(target, key, index);

// src/main.ts
var import_reflect_metadata = require("reflect-metadata");
var import_core = require("@nestjs/core");

// src/app.module.ts
var import_common2 = require("@nestjs/common");

// src/database.service.ts
var import_common = require("@nestjs/common");

// ../../packages/database/src/index.ts
var import_client = require("@prisma/client");

// ../../packages/contracts/src/index.ts
var import_zod = require("zod");
var tenantIdSchema = import_zod.z.uuid();
var employeeDraftSchema = import_zod.z.object({
  employeeNumber: import_zod.z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: import_zod.z.string().trim().min(1).max(160)
}).strict();
var healthSchema = import_zod.z.object({ status: import_zod.z.literal("ok"), service: import_zod.z.literal("kinto-api") }).strict();

// ../../packages/database/src/index.ts
function createDatabase(url) {
  if (!["postgres:", "postgresql:"].includes(new URL(url).protocol))
    throw new Error("PostgreSQL URL required");
  return new import_client.PrismaClient({ datasources: { db: { url } }, log: [] });
}
async function assertSafeRuntimeRole(db) {
  const rows = await db.$queryRaw`
    SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_has_role(current_user, c.relowner, 'MEMBER')
    ) AS unsafe FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (rows.length !== 1 || rows[0].unsafe)
    throw new Error("Unsafe runtime database role");
}

// src/config.ts
var import_zod2 = require("zod");
function readConfig(env) {
  return import_zod2.z.object({
    databaseUrl: import_zod2.z.url().refine(
      (url) => ["postgres:", "postgresql:"].includes(new URL(url).protocol),
      "PostgreSQL URL required"
    ),
    port: import_zod2.z.coerce.number().int().min(1024).max(65535),
    host: import_zod2.z.enum(["127.0.0.1", "0.0.0.0"])
  }).parse({
    databaseUrl: env.DATABASE_URL,
    port: env.API_PORT ?? 4e3,
    host: env.API_HOST ?? "127.0.0.1"
  });
}

// src/database.service.ts
var DatabaseService = class {
  db = createDatabase(readConfig(process.env).databaseUrl);
  async onModuleInit() {
    await assertSafeRuntimeRole(this.db);
  }
  async ready() {
    await assertSafeRuntimeRole(this.db);
    await this.db.$queryRaw`SELECT 1`;
  }
  async onModuleDestroy() {
    await this.db.$disconnect();
  }
};
DatabaseService = __decorateClass([
  (0, import_common.Injectable)()
], DatabaseService);

// src/app.module.ts
var HealthController = class {
  constructor(database) {
    this.database = database;
  }
  live() {
    return { status: "ok", service: "kinto-api" };
  }
  async ready() {
    try {
      await this.database.ready();
      return this.live();
    } catch {
      throw new import_common2.ServiceUnavailableException("Service is not ready");
    }
  }
};
__decorateClass([
  (0, import_common2.Get)("live")
], HealthController.prototype, "live", 1);
__decorateClass([
  (0, import_common2.Get)("ready")
], HealthController.prototype, "ready", 1);
HealthController = __decorateClass([
  (0, import_common2.Controller)("health"),
  __decorateParam(0, (0, import_common2.Inject)(DatabaseService))
], HealthController);
var AppModule = class {
};
AppModule = __decorateClass([
  (0, import_common2.Module)({ controllers: [HealthController], providers: [DatabaseService] })
], AppModule);

// src/http.ts
var import_node_crypto = require("crypto");
var import_common3 = require("@nestjs/common");
var import_helmet = __toESM(require("helmet"));
var SafeExceptionFilter = class {
  catch(error, host) {
    const status = error instanceof import_common3.HttpException ? error.getStatus() : 500;
    const response = host.switchToHttp().getResponse();
    response.status(status).json({
      code: status === 404 ? "NOT_FOUND" : status === 503 ? "SERVICE_UNAVAILABLE" : "REQUEST_FAILED",
      message: status === 404 ? "Resource not found" : status === 503 ? "Service is not ready" : "Request could not be completed",
      requestId: response.getHeader("x-request-id")
    });
  }
};
SafeExceptionFilter = __decorateClass([
  (0, import_common3.Catch)()
], SafeExceptionFilter);
function configureHttp(app) {
  app.setGlobalPrefix("/api/v1");
  app.use((0, import_helmet.default)());
  app.use(
    (_request, response, next) => {
      response.setHeader("x-request-id", (0, import_node_crypto.randomUUID)());
      response.setHeader("cache-control", "no-store");
      next();
    }
  );
  app.useGlobalFilters(new SafeExceptionFilter());
}

// src/main.ts
async function main() {
  const config = readConfig(process.env);
  const app = await import_core.NestFactory.create(AppModule);
  configureHttp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}
main().catch(() => {
  console.error(
    "Kinto API startup failed. Check configuration, database availability and runtime role."
  );
  process.exitCode = 1;
});
