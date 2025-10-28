import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Question } from './model/question.entity';
import { Event } from './model/event.entity';

import { QuestionService } from './service/question.service';
import { EventService } from './service/event.service';
import { GatewayService } from './service/gateway.service';
import { QuestionController } from './controller/question.controller';
import { GatewayController } from './controller/gateway.controller';
import { EventController } from './controller/event.controller';
import { databaseConfig } from './config/database.config';

@Module({
  imports: [
    TypeOrmModule.forRoot(databaseConfig),
    TypeOrmModule.forFeature([Question, Event]),
  ],
  controllers: [AppController, QuestionController, EventController],
  providers: [
    AppService,
    QuestionService,
    EventService,
    GatewayService,
    GatewayController,
  ],
})
export class AppModule {}
