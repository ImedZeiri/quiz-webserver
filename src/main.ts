import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    app.enableCors({
      origin: '*',
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });

    app.useWebSocketAdapter(new IoAdapter(app));
    app.setGlobalPrefix('api');
    const port = process.env.PORT || 3001;
    await app.listen(port);

    console.log(`✅ HTTP Server is running on: http://localhost:${port}`);
    console.log(`💬 WebSocket Server is running on: ws://localhost:${port}`);
  } catch (error) {
    console.error('❌ Error starting server:', error);
    process.exit(1);
  }
}

bootstrap();
