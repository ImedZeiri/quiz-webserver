import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    app.use(cookieParser());
    app.enableCors({
      origin: [
        'http://localhost:4200',
        'http://127.0.0.1:4200',
        'https://www.quiztn.com',
        'https://quiztn.com',
      ],
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    });

    app.useWebSocketAdapter(new IoAdapter(app));
    app.setGlobalPrefix('api');
    const port = process.env.PORT || 80;
    await app.listen(port);

    console.log(` HTTP Server is running on: http://localhost:${port}`);
    console.log(` WebSocket Server is running on: ws://localhost:${port}`);
  } catch (error) {
    console.error(' Error starting server:', error);
    process.exit(1);
  }
}

bootstrap();
