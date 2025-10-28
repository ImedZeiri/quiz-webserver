import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Question } from './entities/question.entity';
import { Event } from './entities/event.entity';
import { JwtModule } from '@nestjs/jwt';
import { QuestionService } from './services/question.service';
import { EventService } from './services/event.service';
import { GatewayService } from './services/gateway.service';
import { QuestionController } from './controllers/question.controller';
import { GatewayController } from './controllers/gateway.controller';
import { databaseConfig } from './config/database.config';
import { UsersService } from './services/users.service';
import { AuthController } from './controllers/auth.controller';
import { User } from './entities/user.entity';
import { AuthService } from './services/auth.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    // Connexion à ta base SQL via TypeORM
    // TypeOrmModule.forRoot(databaseConfig),
    // TypeOrmModule.forFeature([Question, Event, User]),
    // Module JWT
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: '30d' },
      }),
    }),
  ],
  controllers: [AppController, QuestionController, AuthController],
  providers: [
    AppService,
    QuestionService,
    EventService,
    GatewayService,
    GatewayController,
    UsersService,
    AuthService,
  ],
})
export class AppModule {}
