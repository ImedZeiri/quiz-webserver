import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Question, QuestionSchema } from './model/question.entity';
import { Event, EventSchema } from './model/event.entity';
import { QuestionService } from './service/question.service';
import { EventService } from './service/event.service';
import { GatewayService } from './service/gateway.service';
import { QuestionController } from './controller/question.controller';
import { GatewayController } from './controller/gateway.controller';
import { EventController } from './controller/event.controller';
import { QuestionRepository } from './repository/question.repository';
import { EventRepository } from './repository/event.repository';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true,
       envFilePath: '.env',
     }),
  MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI')
      }),
      inject: [ConfigService],
    }),
    MongooseModule.forFeature([
      { name: Question.name, schema: QuestionSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [AppController, QuestionController, EventController],
  providers: [
    AppService,
    QuestionService,
    EventService,
    GatewayService,
    GatewayController,
    QuestionRepository,
    EventRepository,
  ],
})
export class AppModule {}
