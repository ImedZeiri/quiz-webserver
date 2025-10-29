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
import { AuthController } from './controller/auth.controller';
import { UserRepository } from './repository/user.repository';
import { AuthService } from './service/auth.service';
import { UsersService } from './service/users.service';
import { User, UserSchema } from './model/user.entity';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    MongooseModule.forFeature([
      { name: Question.name, schema: QuestionSchema },
      { name: Event.name, schema: EventSchema },
      { name: User.name, schema: UserSchema },
    ]),

    // JWT
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '30d' },
      }),
    }),
  ],
  controllers: [
    AppController,
    QuestionController,
    EventController,
    AuthController,
  ],
  providers: [
    AppService,
    QuestionService,
    EventService,
    GatewayService,
    GatewayController,
    QuestionRepository,
    EventRepository,
    UserRepository,
    AuthService,
    UsersService,
  ],
})
export class AppModule {}
