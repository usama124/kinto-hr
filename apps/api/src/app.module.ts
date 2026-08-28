import {
  Controller,
  Get,
  Inject,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type Health } from '@kinto/contracts';
import { DatabaseService } from './database.service';
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  @Get('live') live(): Health {
    return { status: 'ok', service: 'kinto-api' };
  }
  @Get('ready') async ready(): Promise<Health> {
    try {
      await this.database.ready();
      return this.live();
    } catch {
      throw new ServiceUnavailableException('Service is not ready');
    }
  }
}
@Module({ controllers: [HealthController], providers: [DatabaseService] })
export class AppModule {}
