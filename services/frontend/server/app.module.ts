import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { SsrController } from './ssr.controller';
import { SsrService } from './ssr.service';

@Module({
  controllers: [HealthController, SsrController],
  providers: [SsrService],
})
export class AppModule {}
