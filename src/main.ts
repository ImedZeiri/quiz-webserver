import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';
import cookieParser from 'cookie-parser';

// 🔥 Gestionnaire d'erreurs global
function setupGlobalErrorHandlers() {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Rejet non géré détecté:', reason);
    console.error('Au niveau de la promesse:', promise);
    
    // Ne pas quitter le processus pour les erreurs de base de données
    if (reason instanceof Error) {
      if (reason.message.includes('ECONNRESET') || 
          reason.message.includes('Mongo') || 
          reason.message.includes('database') ||
          reason.message.includes('mongodb')) {
        console.log('🔄 Erreur de base de données détectée, continuation du service...');
        return;
      }
    }
    
    // Logger l'erreur mais continuer le service
    console.log('⚠️  Erreur non critique, continuation du service...');
  });

  process.on('uncaughtException', (error) => {
    console.error('🚨 Exception non attrapée:', error);
    
    // Ne pas quitter le processus pour les erreurs de connexion base de données
    if (error.message.includes('ECONNRESET') || 
        error.message.includes('Mongo') || 
        error.message.includes('database') ||
        error.message.includes('mongodb')) {
      console.log('🔄 Erreur MongoDB, continuation du service...');
      return;
    }
    
    // Quitter seulement pour les erreurs vraiment critiques
    if (error.message.includes('EADDRINUSE') || 
        error.message.includes('port already in use') ||
        error.message.includes('memory') ||
        error.message.includes('FATAL')) {
      console.error('💥 Erreur critique, arrêt du service...');
      process.exit(1);
    }
    
    console.log('⚠️  Exception non critique, continuation du service...');
  });

  // Gestionnaire pour les signaux de fermeture
  process.on('SIGTERM', () => {
    console.log('🛑 Signal SIGTERM reçu, arrêt gracieux...');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('🛑 Signal SIGINT reçu, arrêt gracieux...');
    process.exit(0);
  });
}

async function bootstrap() {
  try {
    // Configurer les gestionnaires d'erreurs globaux
    setupGlobalErrorHandlers();

    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      // 🔥 Options supplémentaires pour la robustesse
      bufferLogs: true,
      abortOnError: false, // Ne pas arrêter sur les erreurs
    });

    // Middleware de base
    app.use(cookieParser());
    
    // Configuration CORS
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

    // Configuration WebSocket
    app.useWebSocketAdapter(new IoAdapter(app));
    
    // Prefix global
    app.setGlobalPrefix('api');

    const port = process.env.PORT || 80;
    
    console.log('🚀 Démarrage du serveur...');
    await app.listen(port);

    console.log(`✅ HTTP Server is running on: http://localhost:${port}`);
    console.log(`✅ WebSocket Server is running on: ws://localhost:${port}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // 🔥 Logger périodique de l'état du service
    setInterval(() => {
      const memoryUsage = process.memoryUsage();
      const memoryMB = {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024),
      };
      
      console.log(`📈 Stats mémoire - RSS: ${memoryMB.rss}MB, Heap: ${memoryMB.heapUsed}/${memoryMB.heapTotal}MB, Uptime: ${Math.round(process.uptime())}s`);
    }, 300000); // Toutes les 5 minutes

  } catch (error) {
    console.error('💥 Error starting server:', error);
    
    // Attendre un peu avant de quitter pour les logs
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
}

// 🔥 Gestionnaire pour les erreurs non attrapées pendant le bootstrap
process.on('uncaughtException', (error) => {
  if (error.message.includes('ECONNRESET') || error.message.includes('Mongo')) {
    console.log('🔄 Erreur MongoDB pendant le démarrage, nouvelle tentative...');
    // Ne pas quitter immédiatement, laisser NestJS gérer
    return;
  }
  console.error('💥 Erreur critique pendant le démarrage:', error);
});

bootstrap();