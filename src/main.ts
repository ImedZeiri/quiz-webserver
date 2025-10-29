// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as os from 'os';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Use IoAdapter for WebSockets
  app.useWebSocketAdapter(new IoAdapter(app));

  // Enable CORS for HTTP only (not WebSocket)
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['Authorization', 'Content-Range', 'X-Content-Range'],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('Quiz')
    .setDescription('The best API documentation ever!')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // Global prefix & validation
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Start server
  const port = process.env.PORT || 3001;
  const server = await app.listen(port, '0.0.0.0');

  // Helper to display IP
  const getIpAddress = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]!) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return 'localhost';
  };

  console.log(`\n🚀 Server running on:`);
  console.log(`   - Local:   http://localhost:${port}`);
  console.log(`   - Network: http://${getIpAddress()}:${port}`);
}

bootstrap();