import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readConfig } from './config';
import { configureHttp } from './http';
async function main() {
  const config = readConfig(process.env);
  const app = await NestFactory.create(AppModule);
  configureHttp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}
main().catch(() => {
  console.error(
    'Kinto API startup failed. Check configuration, database availability and runtime role.',
  );
  process.exitCode = 1;
});
