import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { QuestionService } from './question.service';
import { EventService } from './event.service';
import { UsersService } from './users.service';
import { Question } from '../model/question.entity';
import { Event } from '../model/event.entity';
import type {
  QuizSession,
  GlobalQuiz,
  EventLobby,
  QuizParticipant,
  StartQuizPayload,
  SubmitAnswerPayload,
  PlayerStats,
} from '../types';

interface UserSession {
  socketId: string;
  token: string;
  userId?: string;
  isConnected: boolean;
  isParticipating: boolean;
  participationMode?: 'play' | 'watch';
  isAuthenticated: boolean;
  userType: 'authenticated' | 'guest';
  connectedAt: Date;
  lastActivity?: Date;
  currentContext?: {
    mode: 'home' | 'solo' | 'online' | 'quiz';
    isSolo?: boolean;
    isInLobby?: boolean;
    isInQuiz?: boolean;
    subscriptions: { event: string; enabled: boolean; }[];
    lastUpdated?: Date;
    requiresAuth?: boolean;
  };
}

type UserContext = UserSession['currentContext'];

@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private quizSessions = new Map<string, QuizSession>();
  private globalQuiz: GlobalQuiz | null = null;
  private currentLobby: EventLobby | null = null;
  private userToClientMap = new Map<string, string>();
  private userSessions = new Map<string, UserSession>();
  private isDatabaseConnected = true;
  private eventCheckInterval?: NodeJS.Timeout;
  private nextEventTimer?: NodeJS.Timeout;
  private statsUpdateInterval?: NodeJS.Timeout;
  private lobbyStatusInterval?: NodeJS.Timeout;
  private connectionHealthInterval?: NodeJS.Timeout;
  private systemCheckInterval?: NodeJS.Timeout;
  private statsPendingBroadcast = false;
  private lastLobbyStatus: any = null;

  // 🔥 CORRECTION: Ajout du throttling pour eventCountdown
  private countdownThrottleMap = new Map<string, number>();
  private lastCountdownBroadcast = 0;

  private server: Server;
  private isInitialized = false;

  constructor(
    private readonly questionService: QuestionService,
    private readonly eventService: EventService,
    private readonly usersService: UsersService,
  ) {
    console.log('🔄 GatewayService constructor called');
  }

  onModuleInit() {
    console.log('🚀 GatewayService onModuleInit called');
  }

  setServer(server: Server) {
    console.log('🔧 Setting server in GatewayService');
    this.server = server;
    
    (global as any).gatewayService = this;
    
    this.initializeService();
  }

  private initializeService() {
    if (this.isInitialized) {
      console.log('⚠️ GatewayService already initialized');
      return;
    }
    
    if (!this.server) {
      console.warn('❌ Server not available for initialization');
      return;
    }

    console.log('🚀 Initializing GatewayService with server...');
    
    this.initializeScheduling();
    this.startStatsScheduler();
    this.startConnectionHealthCheck();
    this.startSystemResourcesCheck();
    
    this.isInitialized = true;
    console.log('✅ GatewayService fully initialized');
  }

  onModuleDestroy() {
    console.log('🛑 GatewayService shutting down...');
    this.cleanupAllTimers();
    this.cleanupAllSessions();
  }

  // ======================
  // 🔥 CORRECTION: Méthodes de throttling pour eventCountdown
  // ======================

  /**
   * Vérifie si on peut envoyer un countdown à ce client (throttling)
   */
  private shouldSendCountdown(clientId: string): boolean {
    const now = Date.now();
    const lastSent = this.countdownThrottleMap.get(clientId) || 0;
    const THROTTLE_INTERVAL = 500; // ms entre les envois
    
    if (now - lastSent >= THROTTLE_INTERVAL) {
      this.countdownThrottleMap.set(clientId, now);
      return true;
    }
    return false;
  }

  /**
   * Vérifie si on peut diffuser un countdown global (broadcast throttling)
   */
  private shouldBroadcastCountdown(): boolean {
    const now = Date.now();
    const BROADCAST_INTERVAL = 500; // ms entre les broadcasts globaux
    
    if (now - this.lastCountdownBroadcast >= BROADCAST_INTERVAL) {
      this.lastCountdownBroadcast = now;
      return true;
    }
    return false;
  }

  // ======================
  // CONNECTION HEALTH & SYSTEM CHECK
  // ======================

  private startConnectionHealthCheck() {
    if (!this.server) {
      console.warn('❌ Server not available for health check');
      return;
    }

    console.log('❤️  Starting connection health check...');
    
    this.server.on('connection', (socket) => {
      socket.on('heartbeat_ack', (data) => {
        const session = this.userSessions.get(socket.id);
        if (session) {
          session.lastActivity = new Date();
          console.log(`❤️  Heartbeat ACK from ${socket.id}`);
        }
      });
    });

    this.connectionHealthInterval = setInterval(() => {
      if (!this.server) return;
      
      let heartbeatCount = 0;
      this.userSessions.forEach((session, clientId) => {
        const client = this.server.sockets.sockets.get(clientId);
        if (client && client.connected) {
          client.emit('heartbeat', { 
            timestamp: Date.now(),
            serverTime: new Date().toISOString()
          });
          heartbeatCount++;
        }
      });
      
      if (heartbeatCount > 0) {
        console.log(`❤️  Sent ${heartbeatCount} heartbeats`);
      }
    }, 25000);
  }

  private startSystemResourcesCheck() {
    console.log('🖥️  Starting system resources check...');
    this.systemCheckInterval = setInterval(() => {
      this.checkSystemResources();
    }, 60000);
  }

  private checkSystemResources() {
    const memoryUsage = process.memoryUsage();
    const memoryPercentage = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
    
    if (memoryPercentage > 80) {
      console.warn(`⚠️  Mémoire faible: ${memoryPercentage.toFixed(2)}% - nettoyage des sessions`);
      this.cleanupInactiveSessions();
    }

    if (Date.now() % 300000 < 60000) {
      console.log(`📊 Usage mémoire: ${memoryPercentage.toFixed(2)}% - Sessions: ${this.userSessions.size}`);
    }
  }

  private cleanupInactiveSessions() {
    const now = Date.now();
    const MAX_INACTIVE_TIME = 10 * 60 * 1000;
    
    let cleanedCount = 0;
    
    this.userSessions.forEach((session, clientId) => {
      const lastActivity = session.lastActivity?.getTime() || session.connectedAt.getTime();
      if (now - lastActivity > MAX_INACTIVE_TIME) {
        console.log(`🧹 Nettoyage session inactive: ${clientId}`);
        this.cleanupSession(clientId);
        cleanedCount++;
      }
    });

    if (cleanedCount > 0) {
      console.log(`✅ ${cleanedCount} sessions inactives nettoyées`);
    }
  }

  // ======================
  // CONNECTION ERROR HANDLING
  // ======================

  private handleConnectionError(clientId: string, error: any) {
    console.error(`❌ Erreur connexion ${clientId}:`, error);
    
    const client = this.server?.sockets.sockets.get(clientId);
    if (client) {
      client.emit('connectionError', {
        message: 'Problème de connexion détecté',
        code: 'CONNECTION_ISSUE',
        retry: true,
        timestamp: new Date().toISOString()
      });
    }
  }

  private async recoverConnection(clientId: string) {
    try {
      const session = this.userSessions.get(clientId);
      if (session) {
        this.sendInitialDataToClient(clientId);
        console.log(`✅ Connexion récupérée pour ${clientId}`);
        
        const client = this.server?.sockets.sockets.get(clientId);
        client?.emit('connectionRecovered', {
          message: 'Connexion rétablie',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`❌ Échec récupération connexion ${clientId}:`, error);
    }
  }

  // ======================
  // SCHEDULING & INIT
  // ======================

  private initializeScheduling() {
    console.log('🔄 Initializing scheduling with 3-minute lobby rule...');
    
    setTimeout(() => this.checkAndOpenLobbyIfNeeded(), 1000);
    
    setInterval(() => this.debugEventStatus(), 30000);
    setInterval(() => this.emergencyLobbyCheck(), 60000);
    setInterval(() => this.cleanupExpiredEvents(), 30000);

    this.eventCheckInterval = setInterval(async () => {
      if (this.currentLobby || this.isGlobalQuizActive()) return;
      await this.checkAndOpenLobbyIfNeeded();
    }, 10000);

    setInterval(async () => {
      try {
        if (this.currentLobby || this.isGlobalQuizActive()) return;
        
        const eventsReady = await this.eventService.getEventsReadyForLobby();
        for (const event of eventsReady) {
          const now = Date.now();
          const eventTime = new Date(event.startDate).getTime();
          const lobbyTime = eventTime - 1 * 60 * 1000;
          const endTime = eventTime + 2 * 60 * 1000;
          
          if (now >= lobbyTime && now <= endTime) {
            console.log(`🔄 BACKUP: Ouverture automatique du lobby pour: ${event.theme}`);
            await this.openEventLobby(event);
            break;
          }
        }
      } catch (error) {
        console.error('❌ Error in event scheduler:', error);
        this.handleGatewayError(error);
      }
    }, 15000);

    this.lobbyStatusInterval = setInterval(() => {
      this.checkAndBroadcastLobbyStatus();
    }, 20000);
  }

  private handleGatewayError(error: any): void {
    console.error('🚨 Gateway error:', error);
    this.isDatabaseConnected = false;
    
    setTimeout(() => {
      this.isDatabaseConnected = true;
      console.log('✅ Gateway recovered');
    }, 5000);
  }

  private startStatsScheduler() {
    this.statsUpdateInterval = setInterval(() => {
      if (this.statsPendingBroadcast) {
        this.broadcastUserStats();
        this.statsPendingBroadcast = false;
      }
    }, 5000);
  }

  private scheduleStatsBroadcast() {
    this.statsPendingBroadcast = true;
  }

  // ======================
  // STATS
  // ======================

  private getPlayerStats(): PlayerStats {
    const activePlayers = Array.from(this.quizSessions.values()).filter((s) => !s.isWatching).length;
    const watchingPlayers = Array.from(this.quizSessions.values()).filter((s) => s.isWatching).length;
    return { activePlayers, watchingPlayers, totalPlayers: activePlayers + watchingPlayers };
  }

  private broadcastPlayerStats() {
    if (!this.server) {
      console.warn('❌ Server not available for broadcasting player stats');
      return;
    }

    const stats = this.getPlayerStats();
    let sentCount = 0;
    
    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'playerStats')) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('playerStats', stats);
        sentCount++;
      }
    });
    
    if (sentCount > 0) {
      console.log(`📊 Stats joueurs envoyées à ${sentCount} clients:`, stats);
    }
  }

  private getUserStats() {
    const sessions = Array.from(this.userSessions.values());
    const connectedUsers = sessions.filter((s) => s.isConnected).length;
    const authenticatedUsers = sessions.filter((s) => s.isAuthenticated).length;
    const guestUsers = sessions.filter((s) => !s.isAuthenticated).length;
    const participatingUsers = sessions.filter((s) => s.isParticipating).length;
    const playingUsers = sessions.filter((s) => s.participationMode === 'play').length;
    const watchingUsers = sessions.filter((s) => s.participationMode === 'watch').length;
    const authenticatedPlaying = sessions.filter((s) => s.isAuthenticated && s.participationMode === 'play').length;
    const guestPlaying = sessions.filter((s) => !s.isAuthenticated && s.participationMode === 'play').length;
    const authenticatedWatching = sessions.filter((s) => s.isAuthenticated && s.participationMode === 'watch').length;
    const guestWatching = sessions.filter((s) => !s.isAuthenticated && s.participationMode === 'watch').length;

    return {
      connectedUsers,
      authenticatedUsers,
      guestUsers,
      participatingUsers,
      playingUsers,
      watchingUsers,
      authenticatedPlaying,
      guestPlaying,
      authenticatedWatching,
      guestWatching,
      totalSessions: sessions.length,
    };
  }

  private broadcastUserStats() {
    if (!this.server) {
      console.warn('❌ Server not available for broadcasting user stats');
      return;
    }

    const stats = this.getUserStats();
    let sentCount = 0;
    
    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'userStats')) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('userStats', stats);
        sentCount++;
      }
    });
    
    if (sentCount > 0) {
      console.log(`📊 Stats utilisateurs envoyées à ${sentCount} clients:`, stats);
    }
  }

  // ======================
  // LOBBY MANAGEMENT - CORRIGÉ
  // ======================

private async openEventLobby(event: Event) {
  if (this.currentLobby || this.isGlobalQuizActive()) {
    console.log(`⏭️ Lobby ou quiz déjà actif - pas d'ouverture pour ${event.theme}`);
    return;
  }

  const now = Date.now();
  const eventTime = new Date(event.startDate).getTime();
  const lobbyOpenTime = eventTime - 1 * 60 * 1000;
  const lobbyCloseTime = eventTime;

  if (eventTime <= now) {
    console.log(`❌ Événement ${event.theme} déjà passé (${Math.round((now - eventTime) / 1000)}s) - pas d'ouverture`);
    return;
  }

  if (now < lobbyOpenTime) {
    console.log(`⏰ Événement ${event.theme} trop tôt (dans ${Math.round((lobbyOpenTime - now) / 1000)}s) - pas d'ouverture`);
    return;
  }

  if (now > lobbyCloseTime) {
    console.log(`🚫 Événement ${event.theme} déjà commencé - pas d'ouverture`);
    return;
  }

  console.log(`🎯 Ouverture du lobby pour ${event.theme} (démarre dans ${Math.round((eventTime - now) / 1000)}s)`);

  this.currentLobby = {
    event,
    participants: new Set(),
    countdownTimer: undefined,
    lobbyTimer: undefined,
  };

  if (!event.lobbyOpen) {
    await this.eventService.openLobby(event.id);
  }

  this.startEventCountdown();

  this.userSessions.forEach((session, clientId) => {
    if (this.shouldReceiveEvent(clientId, 'lobbyOpened')) {
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('lobbyOpened', {
        event: {
          id: event.id,
          theme: event.theme || 'Questions Aléatoires',
          numberOfQuestions: event.numberOfQuestions,
          startDate: event.startDate,
          minPlayers: event.minPlayers,
        },
      });
    }
  });

  this.checkAndBroadcastLobbyStatus();
}

  /**
   * 🔥 CORRECTION: Méthode startEventCountdown optimisée avec throttling
   */
  private startEventCountdown() {
    if (!this.currentLobby) return;

    let lastBroadcastTime = 0;
    const BROADCAST_INTERVAL = 500; // ms entre les broadcasts

    const update = () => {
      if (!this.currentLobby) return;
      const now = Date.now();
      const eventTime = new Date(this.currentLobby.event.startDate).getTime();
      const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));

      // 🔥 CORRECTION: Limiter la fréquence d'envoi avec throttling
      if (now - lastBroadcastTime >= BROADCAST_INTERVAL && this.shouldBroadcastCountdown()) {
        lastBroadcastTime = now;
        
        // Envoyer le countdown uniquement aux utilisateurs en mode home
        this.userSessions.forEach((session, clientId) => {
          if (this.shouldReceiveEvent(clientId, 'eventCountdown') && this.shouldSendCountdown(clientId)) {
            const client = this.server?.sockets.sockets.get(clientId);
            client?.emit('eventCountdown', {
              timeLeft,
              participants: this.currentLobby?.participants.size || 0,
              minPlayers: this.currentLobby?.event.minPlayers || 0,
              timestamp: now
            });
          }
        });
      }

      if (timeLeft <= 0) this.startEventIfReady();
    };

    update();
    if (this.currentLobby) {
      this.currentLobby.countdownTimer = setInterval(update, 100); // Garder 100ms pour la précision interne
    }
  }

private async startEventIfReady() {
  if (!this.currentLobby) return;
  
  const eventId = this.currentLobby.event.id;
  const eventTheme = this.currentLobby.event.theme;
  
  clearInterval(this.currentLobby.countdownTimer);
  const { participants, event } = this.currentLobby;

  if (participants.size > 0) {
    const lobbyParticipants = new Set(participants);
    
    this.currentLobby = null;
    
    await this.startEventQuiz(event, lobbyParticipants);
  } else {
    console.log(`Aucun joueur pour ${eventTheme} → événement annulé, prochain dans 1 min`);

    this.currentLobby = null;

    try {
      // 🔥 CORRECTION: Ajout d'un try/catch pour gérer les erreurs de base de données
      await this.eventService.completeEvent(eventId, 'no-winner');
      console.log(`✅ Événement ${eventTheme} marqué comme terminé sans gagnant`);
    } catch (error) {
      console.error(`❌ Erreur lors de la finalisation de l'événement ${eventTheme}:`, error);
      // 🔥 CORRECTION: On continue même si la base de données échoue
    }

    this.safeBroadcast('eventCancelled', {
      reason: 'Aucun joueur présent',
      required: event.minPlayers,
      actual: 0,
    });
  }

  this.initializeNextEvent();
}

  joinLobby(clientId: string) {
    if (!this.currentLobby && !this.isGlobalQuizActive()) {
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    if (this.isGlobalQuizActive() && !this.currentLobby) {
      this.joinOngoingEvent(clientId);
      return;
    }

    if (!this.currentLobby) {
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby disponible' });
      return;
    }

    const wasAlreadyInLobby = this.currentLobby.participants.has(clientId);
    this.currentLobby.participants.add(clientId);

    console.log(`Joueur ${clientId} ${wasAlreadyInLobby ? 'déjà dans' : 'a rejoint'} le lobby. Total: ${this.currentLobby.participants.size}`);
    
    const client = this.server?.sockets.sockets.get(clientId);
    
    client?.emit('lobbyJoined', {
      event: this.currentLobby.event,
      participants: this.currentLobby.participants.size,
      minPlayers: this.currentLobby.event.minPlayers
    });
    
    const now = Date.now();
    const eventTime = new Date(this.currentLobby.event.startDate).getTime();
    const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));
    
    // 🔥 CORRECTION: Utiliser le throttling pour l'envoi initial
    if (this.shouldSendCountdown(clientId)) {
      client?.emit('eventCountdown', {
        timeLeft,
        participants: this.currentLobby.participants.size,
        minPlayers: this.currentLobby.event.minPlayers
      });
    }
    
    this.broadcastLobbyUpdate();
  }

  leaveLobby(clientId: string) {
    if (!this.currentLobby) {
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    if (this.currentLobby.participants.delete(clientId)) {
      console.log(`Joueur ${clientId} a quitté le lobby. Total: ${this.currentLobby.participants.size}`);
      this.broadcastLobbyUpdate();
    }

    const client = this.server?.sockets.sockets.get(clientId);
    client?.emit('lobbyLeft', {
      success: true,
      participants: this.currentLobby.participants.size,
    });
  }

  private broadcastLobbyUpdate() {
    if (!this.currentLobby || !this.server) return;
    
    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'lobbyUpdate')) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('lobbyUpdate', {
          participants: this.currentLobby?.participants.size || 0,
          minPlayers: this.currentLobby?.event.minPlayers || 0,
        });
      }
    });
  }

  // ======================
  // EVENTS
  // ======================

  async handleEventUpdated(updatedEvent: Event) {
  console.log(`🔄 Événement modifié détecté: ${updatedEvent.theme}`);
  const now = new Date().getTime();
  const eventTime = new Date(updatedEvent.startDate).getTime();
  const maxWindow = eventTime + 2 * 60 * 1000;

  if (updatedEvent.isCompleted) {
    console.log(`⏭️ Événement ${updatedEvent.theme} déjà terminé - ignoré`);
    return;
  }

  if (now > maxWindow && !updatedEvent.isCompleted) {
    console.log(`⚠️ Événement ${updatedEvent.theme} expiré - suppression automatique`);
    await this.eventService.updateEvent(updatedEvent.id, { isCompleted: true });
    this.safeBroadcast('eventExpired', {
      id: updatedEvent.id,
      theme: updatedEvent.theme,
    });
    return;
  }

  this.broadcastNextEvent(updatedEvent);

  const timeUntilEvent = eventTime - now;
  if (timeUntilEvent <= 0) {
    console.log(`⏭️ Événement ${updatedEvent.theme} déjà passé - ignoré`);
    return;
  }

  if (this.currentLobby && this.currentLobby.event.id === updatedEvent.id) {
    console.log(`🔄 REMPLACEMENT du lobby existant`);
    const currentParticipants = new Set(this.currentLobby.participants);
    this.destroyCurrentLobby('Événement modifié - recréation du lobby');

    const newEventTime = new Date(updatedEvent.startDate).getTime();
    const newLobbyTime = newEventTime - 1 * 60 * 1000;
    const newEndTime = newEventTime + 2 * 60 * 1000;

    if (now >= newLobbyTime && now <= newEndTime && timeUntilEvent > 0) {
      this.currentLobby = {
        event: updatedEvent,
        participants: currentParticipants,
        countdownTimer: undefined,
        lobbyTimer: undefined,
      };
      if (!updatedEvent.lobbyOpen) {
        await this.eventService.openLobby(updatedEvent.id);
      }
      this.startEventCountdown();
      this.safeBroadcast('lobbyOpened', {
        event: {
          id: updatedEvent.id,
          theme: updatedEvent.theme || 'Questions Aléatoires',
          numberOfQuestions: updatedEvent.numberOfQuestions,
          startDate: updatedEvent.startDate,
          minPlayers: updatedEvent.minPlayers,
        },
        isRecreated: true,
      });
      this.safeBroadcast('lobbyStatus', { isOpen: true, event: updatedEvent });
      const timeLeft = Math.max(0, Math.floor((newEventTime - now) / 1000));
      
      // 🔥 CORRECTION: Utiliser le throttling pour l'envoi du countdown
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'eventCountdown') && this.shouldSendCountdown(clientId)) {
          const client = this.server?.sockets.sockets.get(clientId);
          client?.emit('eventCountdown', {
            timeLeft,
            participants: currentParticipants.size,
            minPlayers: updatedEvent.minPlayers,
          });
        }
      });
      console.log(`✅ NOUVEAU lobby créé avec ${currentParticipants.size} participants`);
    } else {
      console.log(`❌ Nouveau timing invalide - lobby détruit sans recréation`);
    }
  } else if (!this.currentLobby && !this.isGlobalQuizActive()) {
    const newEventTime = new Date(updatedEvent.startDate).getTime();
    const newLobbyTime = newEventTime - 1 * 60 * 1000;
    const newEndTime = newEventTime + 2 * 60 * 1000;
    
    const timeUntilEvent = newEventTime - now;
    if (now >= newLobbyTime && now <= newEndTime && timeUntilEvent > 0) {
      console.log(`🚀 Ouverture d'un nouveau lobby suite à la modification`);
      await this.openEventLobby(updatedEvent);
    } else {
      console.log(`⏭️ Événement ${updatedEvent.theme} hors fenêtre - pas d'ouverture auto`);
    }
  }

  this.safeBroadcast('eventUpdated', {
    id: updatedEvent.id,
    theme: updatedEvent.theme,
    startDate: updatedEvent.startDate,
    numberOfQuestions: updatedEvent.numberOfQuestions,
    minPlayers: updatedEvent.minPlayers,
  });
}

  async handleEventDeleted(eventId: string) {
    console.log(`🗑️ Événement supprimé détecté: ${eventId}`);
    if (this.currentLobby?.event.id === eventId) {
      this.destroyCurrentLobby('Événement supprimé');
    }
    this.safeBroadcast('eventDeleted', { id: eventId });
  }

  private formatEvent(event: Event) {
    return {
      id: event.id,
      theme: event.theme,
      startDate: event.startDate,
      numberOfQuestions: event.numberOfQuestions,
      minPlayers: event.minPlayers,
    };
  }

private broadcastNextEvent(event: Event) {
  if (this.currentLobby || this.isGlobalQuizActive()) return;

  const now = Date.now();
  const eventTime = new Date(event.startDate).getTime();
  const lobbyOpenTime = eventTime - 1 * 60 * 1000;

  if (now >= lobbyOpenTime) {
    console.log(`broadcastNextEvent ignoré: trop proche de l'événement (${event.theme})`);
    return;
  }

  this.userSessions.forEach((session, clientId) => {
    if (this.shouldReceiveEvent(clientId, 'nextEvent')) {
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('nextEvent', this.formatEvent(event));
    }
  });
}

  private async initializeNextEvent() {
    const nextEvent = await this.eventService.getNextEvent();
    if (nextEvent) this.scheduleEventCountdown(nextEvent);
  }

  private scheduleEventCountdown(event: Event) {
    try {
      const now = Date.now();
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 1 * 60 * 1000;

      if (now >= lobbyTime && !event.lobbyOpen) {
        this.openEventLobby(event);
      } else if (lobbyTime > now) {
        const timeUntilLobby = lobbyTime - now;
        console.log(`⏰ Scheduling lobby to open in ${Math.round(timeUntilLobby / 1000)}s for: ${event.theme}`);
        
        this.nextEventTimer = setTimeout(() => {
          this.openEventLobby(event);
        }, timeUntilLobby);
      }

      this.broadcastNextEvent(event);
    } catch (error) {
      console.error('❌ Error in scheduleEventCountdown:', error);
      this.handleGatewayError(error);
    }
  }

  // ======================
  // GLOBAL QUIZ - VERSION CORRECTE
  // ======================

  private validateAndSecureGlobalQuiz(): boolean {
    if (!this.globalQuiz) {
    console.error('❌ globalQuiz est null dans validateAndSecureGlobalQuiz');
    return false;
  }
  
  // 🔥 CORRECTION: Vérifier que event existe
  if (!this.globalQuiz.event) {
    console.error('❌ globalQuiz.event est null dans validateAndSecureGlobalQuiz');
    return false;
  }
    
    if (!this.globalQuiz.timeLimit || this.globalQuiz.timeLimit <= 0) {
      console.warn('⚠️ timeLimit invalide, utilisation de la valeur par défaut (15)');
      this.globalQuiz.timeLimit = 15;
    }
    
    if (this.globalQuiz.timeLeft === undefined || this.globalQuiz.timeLeft === null || this.globalQuiz.timeLeft < 0) {
      console.warn('⚠️ timeLeft invalide, réinitialisation à timeLimit');
      this.globalQuiz.timeLeft = this.globalQuiz.timeLimit;
    }
    
    if (!this.globalQuiz.questions || this.globalQuiz.questions.length === 0) {
      console.error('❌ Aucune question dans globalQuiz');
      return false;
    }
    
    if (!this.globalQuiz.participants) {
      console.warn('⚠️ Participants manquants, création d\'un nouveau Map');
      this.globalQuiz.participants = new Map();
    }
    
    return true;
  }

  private cleanupGlobalQuiz(): void {
    if (this.globalQuiz) {
      if (this.globalQuiz.timerInterval) {
        clearInterval(this.globalQuiz.timerInterval);
        this.globalQuiz.timerInterval = undefined;
      }
      if (this.globalQuiz.timer) {
        clearTimeout(this.globalQuiz.timer);
        this.globalQuiz.timer = undefined;
      }
      
      console.log('🧹 GlobalQuiz nettoyé');
    }
    this.globalQuiz = null;
  }

  private debugGlobalQuizState(operation: string): void {
    console.log(`🔍 Debug globalQuiz (${operation}):`, {
      isNull: this.globalQuiz === null,
      isUndefined: this.globalQuiz === undefined,
      timeLimit: this.globalQuiz?.timeLimit,
      timeLeft: this.globalQuiz?.timeLeft,
      isActive: this.globalQuiz?.isActive,
      questionsCount: this.globalQuiz?.questions?.length,
      participantsCount: this.globalQuiz?.participants?.size
    });
  }

 private async startEventQuiz(event: Event, participants: Set<string>) {
  const questions = await this.getQuestionsByTheme(event.theme, event.numberOfQuestions);
  
  this.globalQuiz = {
    isActive: true,
    currentQuestionIndex: 0,
    questions,
    timeLimit: 15,
    timeLeft: 15,
    event, // 🔥 S'assurer que event n'est jamais null ici
    participants: new Map(),
    timerInterval: undefined,
    timer: undefined
  };

    for (const clientId of participants) {
      this.globalQuiz.participants.set(clientId, { clientId, score: 0, answers: [] });
      const session: QuizSession = {
        questions,
        currentIndex: 0,
        score: 0,
        answers: [],
        isWatching: false,
        timeLimit: 15,
        timeLeft: 15,
        joinedAt: 0,
      };
      this.quizSessions.set(clientId, session);
      this.updateUserParticipation(clientId, true, 'play');
    }

    for (const clientId of participants) {
      const userSession = this.userSessions.get(clientId);
      if (userSession?.isAuthenticated) {
        const client = this.server?.sockets.sockets.get(clientId);
        client?.emit('eventStarted', { event: this.formatEvent(event) });
        client?.emit('autoStartQuiz', {
          theme: event.theme,
          limit: event.numberOfQuestions,
          timeLimit: 30,
        });
      }
    }

    this.startGlobalQuiz();
  }

private startGlobalQuiz() {
  this.debugGlobalQuizState('before startGlobalQuiz');
  
  if (!this.globalQuiz) {
    console.error('❌ Cannot start global quiz: globalQuiz is null');
    return;
  }

  if (!this.validateAndSecureGlobalQuiz()) {
    console.error('❌ Impossible de démarrer le quiz global: validation échouée');
    this.globalQuiz = null;
    return;
  }

  const quiz = this.globalQuiz;

  setTimeout(() => {
    if (!this.globalQuiz) {
      console.error('❌ globalQuiz est devenu null pendant le délai');
      return;
    }
    
    this.broadcastCurrentQuestion();
    
    console.log(`⏰ Démarrage du timer global: ${this.globalQuiz.timeLeft}s`);
    
    quiz.timerInterval = setInterval(() => {
      if (!this.globalQuiz) {
        console.error('❌ globalQuiz est null pendant le timer - nettoyage');
        if (quiz.timerInterval) clearInterval(quiz.timerInterval);
        return;
      }

      this.globalQuiz.timeLeft--;
      
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'timerUpdate')) {
          const client = this.server?.sockets.sockets.get(clientId);
          client?.emit('timerUpdate', {
            timeLeft: this.globalQuiz?.timeLeft || 0,
            ...this.getPlayerStats(),
          });
        }
      });
      
      if (this.globalQuiz.timeLeft <= 0) {
        this.handleGlobalTimeExpired();
      }
    }, 1000);

    quiz.timer = setTimeout(() => {
      if (!this.globalQuiz) {
        console.error('❌ globalQuiz est null dans le timeout final');
        return;
      }
      this.handleGlobalTimeExpired();
    }, quiz.timeLimit * 1000);
  }, 1000);
}

  private broadcastCurrentQuestion() {
    if (!this.globalQuiz) return;
  
    const { currentQuestionIndex, timeLeft } = this.globalQuiz;
  
    this.quizSessions.forEach((session, clientId) => {
      if (!this.globalQuiz?.participants.has(clientId)) return;
      
      const client = this.server?.sockets.sockets.get(clientId);
      if (!client) return;
  
      session.currentIndex = currentQuestionIndex;
      session.timeLeft = timeLeft;
      session.pendingAnswer = undefined;
      this.sendCurrentQuestion(client, session);
    });
  }

  private sendCurrentQuestion(client: Socket, session: QuizSession) {
    const currentQuestion = session.questions[session.currentIndex];

    let previousAnswer: any = null;
    if (session.answers.length > 0) {
      const lastAnswer = session.answers[session.answers.length - 1];
      const previousQuestionIndex = session.currentIndex - 1;
      if (previousQuestionIndex >= 0) {
        const previousQuestion = session.questions[previousQuestionIndex];
        const correctResponseText = this.getResponseText(previousQuestion, previousQuestion.correctResponse);
        previousAnswer = {
          ...lastAnswer,
          correctAnswer: previousQuestion.correctResponse,
          correctResponseText,
        };
      } else {
        previousAnswer = lastAnswer;
      }
    }

    client.emit('quizQuestion', {
      question: {
        id: currentQuestion.id,
        theme: currentQuestion.theme,
        questionText: currentQuestion.questionText,
        response1: currentQuestion.response1,
        response2: currentQuestion.response2,
        response3: currentQuestion.response3,
        response4: currentQuestion.response4,
      },
      questionNumber: session.currentIndex + 1,
      totalQuestions: session.questions.length,
      previousAnswer,
      isWatching: session.isWatching,
      timeLeft: session.timeLeft,
      ...this.getPlayerStats(),
    });
  }

  private getResponseText(question: Question, responseIndex: number): string {
    const responses = [question.response1, question.response2, question.response3, question.response4];
    return responses[responseIndex - 1] || '';
  }

  submitAnswer(clientId: string, payload: SubmitAnswerPayload) {
    const session = this.quizSessions.get(clientId);
    const client = this.server?.sockets.sockets.get(clientId);
    if (!session) {
      client?.emit('error', { message: 'Aucune session de quiz active' });
      return;
    }
    if (session.isWatching) {
      client?.emit('error', { message: 'Vous êtes en mode surveillance - réponses bloquées' });
      return;
    }
    const currentQuestion = session.questions[session.currentIndex];
    if (currentQuestion.id !== payload.questionId) {
      client?.emit('error', { message: 'Question invalide' });
      return;
    }
    if (session.timeLeft <= 0) {
      client?.emit('error', { message: 'Temps expiré - réponse non acceptée' });
      return;
    }

    const isFinalQuestion =
      this.globalQuiz &&
      this.globalQuiz.currentQuestionIndex === this.globalQuiz.questions.length - 1;

    if (isFinalQuestion) {
      const isCorrect = currentQuestion.correctResponse === payload.answer;
      if (isCorrect) {
        this.handleFinalQuestionCorrectAnswer(clientId, payload);
        return;
      }
    }

    session.pendingAnswer = { questionId: payload.questionId, answer: payload.answer };
    client?.emit('answerQueued', { questionId: payload.questionId, answer: payload.answer, timeLeft: session.timeLeft });
  }

  private handleGlobalTimeExpired() {
    if (!this.globalQuiz) return;
    if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

    this.quizSessions.forEach((session, clientId) => {
      if (session.currentIndex === this.globalQuiz!.currentQuestionIndex) {
        const currentQuestion = session.questions[session.currentIndex];
        let userAnswer = 0;
        let isCorrect = false;

        if (!session.isWatching && session.pendingAnswer && session.pendingAnswer.questionId === currentQuestion.id) {
          userAnswer = session.pendingAnswer.answer;
          isCorrect = currentQuestion.correctResponse === userAnswer;
          if (isCorrect) {
            session.score++;
            const participant = this.globalQuiz!.participants?.get(clientId);
            if (participant) {
              participant.score = session.score;
              if (this.globalQuiz!.currentQuestionIndex === this.globalQuiz!.questions.length - 1) {
                participant.finishedAt = new Date();
              }
            }
          } else {
            session.isWatching = true;
            this.updateUserParticipation(clientId, true, 'watch');
          }
        } else if (!session.isWatching) {
          session.isWatching = true;
          this.updateUserParticipation(clientId, true, 'watch');
        }

        const submittedAt = Date.now();
        const answerData = {
          questionId: currentQuestion.id,
          userAnswer,
          correct: isCorrect,
          submittedAt,
        };
        session.answers.push(answerData);

        const participant = this.globalQuiz!.participants?.get(clientId);
        if (participant) {
          participant.answers.push(answerData);
          participant.lastCorrectAnswerTime = isCorrect ? submittedAt : undefined;
        }

        session.pendingAnswer = undefined;
      }
    });

    this.broadcastPlayerStats();
    this.globalQuiz.currentQuestionIndex++;

    if (this.globalQuiz.currentQuestionIndex >= this.globalQuiz.questions.length) {
      this.completeGlobalQuiz();
    } else {
      const isNextFinal = this.globalQuiz.currentQuestionIndex === this.globalQuiz.questions.length - 1;
      if (isNextFinal) {
        this.startAdBreakBeforeFinalQuestion();
      } else {
        this.globalQuiz.timeLeft = this.globalQuiz.timeLimit;
        this.startGlobalQuiz();
      }
    }

    this.scheduleStatsBroadcast();
  }

private async completeGlobalQuiz() {
  if (!this.globalQuiz) return;
  
  const event = this.globalQuiz.event;
  const participants = this.globalQuiz.participants;
  
  // 🔥 CORRECTION: Sauvegarder le gagnant AVANT de nettoyer
  let winnerSessionId: string | null = null;
  let winnerUsername: string | null = null;
  let winnerPhone: string | null = null;

  if (event && participants && participants.size > 0) {
    // 🔥 CORRECTION: Trier par score puis par temps
    const sortedParticipants = Array.from(participants.values())
      .filter(p => p.score > 0) // Seulement ceux qui ont marqué
      .sort((a, b) => {
        // D'abord par score (décroissant)
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        // Ensuite par temps (croissant - le plus rapide gagne)
        return (a.lastCorrectAnswerTime || Infinity) - (b.lastCorrectAnswerTime || Infinity);
      });
    
    if (sortedParticipants.length > 0) {
      winnerSessionId = sortedParticipants[0].clientId;
      const winnerInfo = await this.getWinnerInfo(winnerSessionId);
      winnerUsername = winnerInfo.username || null;
      winnerPhone = winnerInfo.phoneNumber || null;

      console.log(`🏆 Winner determined:`, {
        sessionId: winnerSessionId,
        username: winnerUsername,
        phone: winnerPhone,
        score: sortedParticipants[0].score,
        totalParticipants: participants.size
      });

      try {
        // 🔥 CORRECTION: Utiliser le phone comme identifiant principal
        const winnerIdentifier = winnerPhone || winnerSessionId;
        console.log(`💾 Saving winner to database: ${winnerIdentifier} for event ${event.id}`);
        
        await this.eventService.completeEvent(event.id, winnerIdentifier);
        console.log(`✅ Event ${event.theme} completed with winner: ${winnerIdentifier}`);
      } catch (error) {
        console.error(`❌ Error completing event ${event.theme}:`, error);
        // 🔥 CORRECTION: Essayer avec session ID si phone échoue
        try {
          await this.eventService.completeEvent(event.id, winnerSessionId!);
          console.log(`✅ Event ${event.theme} completed with session ID: ${winnerSessionId}`);
        } catch (secondError) {
          console.error(`❌ Second attempt failed for event ${event.theme}:`, secondError);
        }
      }

      // Notifier tous les clients
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'eventCompleted')) {
          const client = this.server?.sockets.sockets.get(clientId);
          client?.emit('eventCompleted', {
            eventId: event.id,
            winner: winnerUsername || winnerSessionId,
            winnerPhone,
            winnerDisplay: winnerUsername ? `🏆 ${winnerUsername}` : `Session: ${winnerSessionId}`,
            winnerScore: sortedParticipants[0].score,
            totalParticipants: participants.size
          });
        }
      });
    } else {
      console.log('❌ No valid winner found - all participants scored 0');
      
      try {
        // Marquer l'événement comme complété sans gagnant
        await this.eventService.completeEvent(event.id, 'no-winner');
        console.log(`✅ Event ${event.theme} marked as completed without winner`);
      } catch (error) {
        console.error(`❌ Error completing event without winner:`, error);
      }
    }
  } else {
    console.log('❌ No participants or event for global quiz completion');
    
    if (event) {
      try {
        await this.eventService.completeEvent(event.id, 'no-winner');
        console.log(`✅ Event ${event.theme} marked as completed without participants`);
      } catch (error) {
        console.error(`❌ Error completing event without participants:`, error);
      }
    }
  }

  // 🔥 CORRECTION: Nettoyer APRÈS avoir sauvegardé le gagnant
  this.cleanupGlobalQuiz();
  
  // Notifier la fin du quiz à tous les participants
  this.quizSessions.forEach((session, clientId) => {
    const client = this.server?.sockets.sockets.get(clientId);
    if (client) {
      const isWinner = clientId === winnerSessionId;
      client.emit('quizCompleted', {
        score: session.score,
        totalQuestions: session.questions.length,
        answers: session.answers,
        joinedAt: session.joinedAt,
        winner: winnerUsername || winnerSessionId,
        isWinner: isWinner,
        winnerScore: winnerSessionId ? participants?.get(winnerSessionId)?.score : 0,
        totalParticipants: participants?.size || 0
      });
    }
  });

  // Nettoyer les sessions après un délai
  setTimeout(() => {
    this.quizSessions.clear();
    this.currentLobby = null;
    console.log('🧹 Quiz sessions cleaned up');
  }, 5000);
}

  private startAdBreakBeforeFinalQuestion() {
    if (!this.globalQuiz) return;
    console.log('📺 Démarrage de la pause publicitaire avant la dernière question');

    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'adBreakStarted')) {
        const client = this.server?.sockets.sockets.get(clientId);
        client?.emit('adBreakStarted', {
          duration: 15,
          message: 'Pause publicitaire avant la dernière question',
          isFinalQuestion: true,
        });
      }
    });

    let countdown = 15;
    const adCountdownInterval = setInterval(() => {
      countdown--;
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'adBreakCountdown')) {
          const client = this.server?.sockets.sockets.get(clientId);
          client?.emit('adBreakCountdown', { timeLeft: countdown });
        }
      });
      if (countdown <= 0) {
        clearInterval(adCountdownInterval);
        this.userSessions.forEach((session, clientId) => {
          if (this.shouldReceiveEvent(clientId, 'adBreakEnded')) {
            const client = this.server?.sockets.sockets.get(clientId);
            client?.emit('adBreakEnded');
          }
        });
        this.globalQuiz!.timeLeft = this.globalQuiz!.timeLimit;
        this.startGlobalQuiz();
      }
    }, 1000);
  }

  private async handleFinalQuestionCorrectAnswer(clientId: string, payload: SubmitAnswerPayload) {
  if (!this.globalQuiz) return;
  console.log(`🏆 Première réponse correcte sur la dernière question par ${clientId}`);

  if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
  if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

  const session = this.quizSessions.get(clientId);
  if (session) {
    const currentQuestion = session.questions[session.currentIndex];
    session.score++;
    const participant = this.globalQuiz.participants?.get(clientId);
    if (participant) {
      participant.score = session.score;
      participant.finishedAt = new Date();
      participant.lastCorrectAnswerTime = Date.now();
      const answerData = {
        questionId: currentQuestion.id,
        userAnswer: payload.answer,
        correct: true,
        submittedAt: Date.now(),
      };
      session.answers.push(answerData);
      participant.answers.push(answerData);
    }
  }

  const winnerInfo = await this.getWinnerInfo(clientId);
  const winnerUsername = winnerInfo.username || null;
  const winnerPhone = winnerInfo.phoneNumber || null;

  if (this.globalQuiz.event) {
    try {
      // 🔥 CORRECTION: Sauvegarder le gagnant
      const winnerIdentifier = winnerPhone || clientId;
      console.log(`💾 Saving immediate winner to database: ${winnerIdentifier}`);
      
      await this.eventService.completeEvent(this.globalQuiz.event.id, winnerIdentifier);
      console.log(`✅ Event ${this.globalQuiz.event.theme} completed with immediate winner: ${winnerIdentifier}`);
    } catch (error) {
      console.error(`❌ Error completing event with immediate winner:`, error);
      // 🔥 CORRECTION: Essayer avec session ID
      try {
        await this.eventService.completeEvent(this.globalQuiz.event.id, clientId);
        console.log(`✅ Event ${this.globalQuiz.event.theme} completed with session ID: ${clientId}`);
      } catch (secondError) {
        console.error(`❌ Second attempt failed for immediate winner:`, secondError);
      }
    }

    this.userSessions.forEach((session, sessionClientId) => {
      if (this.shouldReceiveEvent(sessionClientId, 'immediateWinner')) {
        const client = this.server?.sockets.sockets.get(sessionClientId);
        client?.emit('immediateWinner', {
          eventId: this.globalQuiz?.event?.id || '',
          winner: winnerUsername || clientId,
          winnerPhone,
          winnerDisplay: winnerUsername ? `🏆 ${winnerUsername}` : `Session: ${clientId}`,
          message: 'Première réponse correcte sur la dernière question !',
        });
      }
    });
  }

  this.quizSessions.forEach((session, sessionClientId) => {
    const client = this.server?.sockets.sockets.get(sessionClientId);
    if (client) {
      client.emit('quizCompleted', {
        score: session.score,
        totalQuestions: session.questions.length,
        answers: session.answers,
        joinedAt: session.joinedAt,
        winner: winnerUsername || clientId,
        isWinner: sessionClientId === clientId,
        immediateWin: true,
      });
    }
  });

  // 🔥 CORRECTION: Nettoyer après un délai
  setTimeout(() => {
    this.globalQuiz = null;
    this.quizSessions.clear();
    this.currentLobby = null;
    console.log('🧹 Immediate win sessions cleaned up');
  }, 5000);
}

  // ======================
  // CONNECTION / DISCONNECTION
  // ======================

handleConnection(clientId: string) {
  console.log(`🔌 Client connected: ${clientId}`);
  
  if (this.userSessions.has(clientId)) {
    console.warn(`⚠️ Client ${clientId} déjà dans les sessions - nettoyage`);
    this.cleanupSession(clientId);
  }
  
  this.userSessions.set(clientId, {
    socketId: clientId,
    token: '',
    isConnected: true,
    isParticipating: false,
    isAuthenticated: false,
    userType: 'guest',
    connectedAt: new Date(),
    lastActivity: new Date(),
  });

  console.log(`✅ Session créée pour ${clientId}, total sessions: ${this.userSessions.size}`);

  setTimeout(() => {
    this.sendInitialDataToClient(clientId);
  }, 500);

  this.checkAndOpenLobbyIfNeeded();
  this.scheduleStatsBroadcast();
}

handleDisconnection(clientId: string, reason?: string) {
  console.log(`🔌 Client disconnected: ${clientId} - Reason: ${reason}`);
  
  if (reason === 'ping timeout') {
    console.log(`⏰ Timeout ping pour ${clientId}`);
  } else if (reason === 'transport close') {
    console.log(`🚪 Transport fermé pour ${clientId}`);
  } else if (reason === 'transport error') {
    console.log(`❌ Erreur transport pour ${clientId}`);
  } else if (reason === 'forced close') {
    console.log(`🛑 Fermeture forcée pour ${clientId}`);
  }
  
  this.cleanupSession(clientId);
}

  // ======================
  // SESSION & CLEANUP
  // ======================

  private cleanupSession(clientId: string) {
    const userSession = this.userSessions.get(clientId);
    if (userSession?.userId) {
      const currentClientId = this.userToClientMap.get(userSession.userId);
      if (currentClientId === clientId) {
        this.userToClientMap.delete(userSession.userId);
      }
    }

    this.userSessions.delete(clientId);

    // 🔥 CORRECTION: Nettoyer aussi le throttling map
    this.countdownThrottleMap.delete(clientId);

    const session = this.quizSessions.get(clientId);
    if (session?.timer) clearTimeout(session.timer);
    if (session?.timerInterval) clearInterval(session.timerInterval);
    this.quizSessions.delete(clientId);

    if (this.globalQuiz?.participants) this.globalQuiz.participants.delete(clientId);
    if (this.currentLobby?.participants.has(clientId)) {
      this.currentLobby.participants.delete(clientId);
      this.broadcastLobbyUpdate();
    }

    this.scheduleStatsBroadcast();
  }

  private cleanupAllSessions() {
    for (const clientId of this.userSessions.keys()) {
      this.cleanupSession(clientId);
    }
  }

  private cleanupAllTimers() {
    const timers = [
      this.eventCheckInterval,
      this.nextEventTimer,
      this.statsUpdateInterval,
      this.lobbyStatusInterval,
      this.connectionHealthInterval,
      this.systemCheckInterval
    ];

    timers.forEach(timer => {
      if (timer) {
        clearInterval(timer as NodeJS.Timeout);
      }
    });

    // 🔥 CORRECTION: Nettoyer le throttling map
    this.countdownThrottleMap.clear();
  }

  private destroyCurrentLobby(reason: string = 'Lobby détruit') {
    if (!this.currentLobby) return;

    if (this.currentLobby.countdownTimer) clearInterval(this.currentLobby.countdownTimer);
    if (this.currentLobby.lobbyTimer) clearTimeout(this.currentLobby.lobbyTimer);

    const eventId = this.currentLobby.event.id;
    this.currentLobby = null;

    this.safeBroadcast('lobbyClosed', { reason, eventId });
    this.checkAndBroadcastLobbyStatus();
  }

  // ======================
  // CONTEXT MANAGEMENT
  // ======================

  setUserContext(clientId: string, payload: { mode: string; isSolo?: boolean; isInLobby?: boolean; isInQuiz?: boolean }) {
    const userSession = this.userSessions.get(clientId);
    if (!userSession) {
      console.warn(`Tentative de définir le contexte pour un utilisateur inexistant: ${clientId}`);
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('error', { 
        message: 'Session utilisateur non trouvée. Veuillez vous reconnecter.',
        code: 'SESSION_NOT_FOUND',
        requiredAction: 'RECONNECT'
      });
      return;
    }

    const authValidation = this.validateAuthenticationForMode(payload.mode as any, payload, userSession);
    if (!authValidation.isValid) {
      console.warn(`⚠️ Accès refusé pour ${clientId}: ${authValidation.reason}`);
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('error', authValidation.error);
      return;
    }

    if (userSession.currentContext) {
      console.log(`🔄 Changement de contexte pour ${clientId}: ${userSession.currentContext.mode} → ${payload.mode}`);
      this.cleanupPreviousContext(clientId, userSession.currentContext);
    }

    const contextSubscriptions = this.getContextSubscriptions(payload.mode as any, payload);
    
    userSession.currentContext = {
      mode: payload.mode as any,
      isSolo: payload.isSolo,
      isInLobby: payload.isInLobby,
      isInQuiz: payload.isInQuiz,
      subscriptions: contextSubscriptions,
      lastUpdated: new Date(),
      requiresAuth: this.doesModeRequireAuth(payload.mode as any, payload)
    };
    
    userSession.lastActivity = new Date();

    const enabledEvents = contextSubscriptions.filter(s => s.enabled).map(s => s.event);
    const disabledEvents = contextSubscriptions.filter(s => !s.enabled).map(s => s.event);
    
    console.log(`📍 Contexte défini pour ${clientId}: ${payload.mode}`, {
      isSolo: payload.isSolo,
      isInLobby: payload.isInLobby,
      isInQuiz: payload.isInQuiz,
      isAuthenticated: userSession.isAuthenticated,
      userType: userSession.userType,
      enabledEvents: enabledEvents,
      disabledEvents: disabledEvents
    });

    this.sendContextualData(clientId, userSession.currentContext);
    
    const client = this.server?.sockets.sockets.get(clientId);
    client?.emit('contextSet', {
      mode: payload.mode,
      success: true,
      enabledEvents: contextSubscriptions.filter(s => s.enabled).map(s => s.event)
    });
  }

  private validateAuthenticationForMode(
    mode: 'home' | 'solo' | 'online' | 'quiz', 
    payload: any, 
    userSession: UserSession
  ): { isValid: boolean; reason?: string; error?: any } {
    if (mode === 'home') {
      return { isValid: true };
    }

    if (mode === 'solo' && payload.isSolo === true) {
      return { isValid: true };
    }

    if (mode === 'online' && !userSession.isAuthenticated) {
      return {
        isValid: false,
        reason: 'Mode online nécessite une authentification',
        error: {
          message: 'Le mode en ligne nécessite une authentification. Veuillez vous connecter.',
          code: 'AUTH_REQUIRED_FOR_ONLINE',
          requiredAction: 'LOGIN'
        }
      };
    }

    if (mode === 'quiz') {
      if (payload.isSolo === true) {
        return { isValid: true };
      }
      
      if (!userSession.isAuthenticated) {
        return {
          isValid: false,
          reason: 'Quiz multijoueur nécessite une authentification',
          error: {
            message: 'Le quiz multijoueur nécessite une authentification. Veuillez vous connecter.',
            code: 'AUTH_REQUIRED_FOR_MULTIPLAYER',
            requiredAction: 'LOGIN'
          }
        };
      }
    }

    return { isValid: true };
  }

  private doesModeRequireAuth(mode: 'home' | 'solo' | 'online' | 'quiz', payload: any): boolean {
    if (mode === 'home') return false;
    if (mode === 'solo' && payload.isSolo === true) return false;
    if (mode === 'online') return true;
    if (mode === 'quiz' && !payload.isSolo) return true;
    return false;
  }

  private cleanupPreviousContext(clientId: string, previousContext: NonNullable<UserContext>): void {
    if (previousContext.mode === 'quiz' && previousContext.isInQuiz) {
      const session = this.quizSessions.get(clientId);
      if (session && !this.isGlobalQuizActive()) {
        this.quizSessions.delete(clientId);
      }
    }
    
    if (previousContext.mode === 'online' && previousContext.isInLobby) {
      if (this.currentLobby?.participants.has(clientId)) {
        this.currentLobby.participants.delete(clientId);
        this.broadcastLobbyUpdate();
      }
    }
    
    console.log(`🧹 Contexte précédent nettoyé pour ${clientId}: ${previousContext.mode}`);
  }

  private getContextSubscriptions(mode: 'home' | 'solo' | 'online' | 'quiz', payload: any): { event: string; enabled: boolean; }[] {
    const baseSubscriptions = [
      { event: 'connectionStatus', enabled: true },
      { event: 'error', enabled: true },
      { event: 'forceLogout', enabled: true },
      { event: 'heartbeat', enabled: true },
      { event: 'connectionError', enabled: true },
      { event: 'connectionRecovered', enabled: true }
    ];

    switch (mode) {
      case 'home':
        return [
          ...baseSubscriptions,
          { event: 'userStats', enabled: true },
          { event: 'nextEvent', enabled: true },
          { event: 'lobbyOpened', enabled: true },
          { event: 'lobbyStatus', enabled: true },
          { event: 'eventCountdown', enabled: false },
          { event: 'lobbyClosed', enabled: true },
          { event: 'eventUpdated', enabled: false },
          { event: 'eventDeleted', enabled: true },
          { event: 'eventExpired', enabled: true },
          { event: 'authenticationConfirmed', enabled: true },
          { event: 'soloQuestions', enabled: false },
          { event: 'quizQuestion', enabled: false },
          { event: 'timerUpdate', enabled: false },
          { event: 'answerQueued', enabled: false },
          { event: 'playerStats', enabled: false },
          { event: 'quizCompleted', enabled: false },
          { event: 'eventStarted', enabled: false },
          { event: 'eventCompleted', enabled: false },
          { event: 'autoStartQuiz', enabled: false },
          { event: 'adBreakStarted', enabled: false },
          { event: 'adBreakCountdown', enabled: false },
          { event: 'adBreakEnded', enabled: false },
          { event: 'immediateWinner', enabled: false },
          { event: 'answerResult', enabled: false }
        ];
      
      case 'solo':
        return [
          ...baseSubscriptions,
          { event: 'soloQuestions', enabled: true },
          { event: 'userStats', enabled: false },
          { event: 'nextEvent', enabled: false },
          { event: 'lobbyOpened', enabled: false },
          { event: 'lobbyStatus', enabled: false },
          { event: 'eventCountdown', enabled: false },
          { event: 'lobbyClosed', enabled: false },
          { event: 'eventUpdated', enabled: false },
          { event: 'eventDeleted', enabled: false },
          { event: 'eventExpired', enabled: false },
          { event: 'quizQuestion', enabled: false },
          { event: 'quizCompleted', enabled: false },
          { event: 'timerUpdate', enabled: false },
          { event: 'answerQueued', enabled: false },
          { event: 'playerStats', enabled: false },
          { event: 'eventStarted', enabled: false },
          { event: 'eventCompleted', enabled: false },
          { event: 'lobbyJoined', enabled: false },
          { event: 'lobbyUpdate', enabled: false },
          { event: 'lobbyLeft', enabled: false },
          { event: 'eventCancelled', enabled: false },
          { event: 'autoStartQuiz', enabled: false },
          { event: 'joinedInProgress', enabled: false },
          { event: 'adBreakStarted', enabled: false },
          { event: 'adBreakCountdown', enabled: false },
          { event: 'adBreakEnded', enabled: false },
          { event: 'immediateWinner', enabled: false },
          { event: 'answerResult', enabled: false },
          { event: 'authenticationConfirmed', enabled: false }
        ];
      
      case 'online':
      case 'quiz':
        const isInLobby = payload.isInLobby;
        const isInQuiz = payload.isInQuiz;
        const isSolo = payload.isSolo;
        
        if (isSolo === true) {
          return [
            ...baseSubscriptions,
            { event: 'soloQuestions', enabled: true },
            { event: 'userStats', enabled: false },
            { event: 'nextEvent', enabled: false },
            { event: 'lobbyOpened', enabled: false },
            { event: 'lobbyStatus', enabled: false },
            { event: 'eventCountdown', enabled: false },
            { event: 'playerStats', enabled: false },
            { event: 'quizQuestion', enabled: false },
            { event: 'timerUpdate', enabled: false },
            { event: 'eventStarted', enabled: false },
            { event: 'eventCompleted', enabled: false },
            { event: 'authenticationConfirmed', enabled: false }
          ];
        }
        
        const onlineSubscriptions = [
          ...baseSubscriptions,
          { event: 'userStats', enabled: true },
          { event: 'eventStarted', enabled: true },
          { event: 'eventCompleted', enabled: true },
          { event: 'lobbyJoined', enabled: true },
          { event: 'lobbyUpdate', enabled: true },
          { event: 'lobbyLeft', enabled: true },
          { event: 'eventCancelled', enabled: true },
          { event: 'autoStartQuiz', enabled: true },
          { event: 'joinedInProgress', enabled: true },
          { event: 'authenticationConfirmed', enabled: true },
          { event: 'nextEvent', enabled: false },
          { event: 'lobbyOpened', enabled: false },
          { event: 'lobbyStatus', enabled: false },
          { event: 'soloQuestions', enabled: false }
        ];
        
        if (isInLobby) {
          onlineSubscriptions.push(
            { event: 'eventCountdown', enabled: true },
            { event: 'lobbyClosed', enabled: true }
          );
        } else {
          onlineSubscriptions.push(
            { event: 'eventCountdown', enabled: false },
            { event: 'lobbyClosed', enabled: false }
          );
        }
        
        if (isInQuiz) {
          onlineSubscriptions.push(
            { event: 'quizQuestion', enabled: true },
            { event: 'quizCompleted', enabled: true },
            { event: 'timerUpdate', enabled: true },
            { event: 'answerQueued', enabled: true },
            { event: 'playerStats', enabled: true },
            { event: 'adBreakStarted', enabled: true },
            { event: 'adBreakCountdown', enabled: true },
            { event: 'adBreakEnded', enabled: true },
            { event: 'immediateWinner', enabled: true },
            { event: 'answerResult', enabled: true }
          );
        } else {
          onlineSubscriptions.push(
            { event: 'quizQuestion', enabled: false },
            { event: 'quizCompleted', enabled: false },
            { event: 'timerUpdate', enabled: false },
            { event: 'answerQueued', enabled: false },
            { event: 'playerStats', enabled: false },
            { event: 'adBreakStarted', enabled: false },
            { event: 'adBreakCountdown', enabled: false },
            { event: 'adBreakEnded', enabled: false },
            { event: 'immediateWinner', enabled: false },
            { event: 'answerResult', enabled: false }
          );
        }
        
        return onlineSubscriptions;
      
      default:
        return baseSubscriptions;
    }
  }

  private sendContextualData(clientId: string, context: any) {
    const client = this.server?.sockets.sockets.get(clientId);
    if (!client) return;

    switch (context.mode) {
      case 'home':
        client.emit('userStats', this.getUserStats());
        this.sendNextEventIfAllowed(clientId);
        this.sendLobbyStatusToClient(clientId);
        break;
      
      case 'solo':
        break;
      
      case 'online':
      case 'quiz':
        client.emit('userStats', this.getUserStats());
        client.emit('playerStats', this.getPlayerStats());
        
        if (this.isGlobalQuizActive()) {
          this.joinOngoingEvent(clientId);
        }
        break;
    }
  }

  private shouldReceiveEvent(clientId: string, eventName: string): boolean {
    const userSession = this.userSessions.get(clientId);
    
    if (!userSession) {
      const essentialEvents = ['error', 'forceLogout', 'connectionStatus', 'userStats', 'lobbyStatus', 'nextEvent', 'heartbeat', 'connectionError'];
      return essentialEvents.includes(eventName);
    }
    
    const guestAllowedEvents = ['userStats', 'lobbyStatus', 'nextEvent', 'lobbyOpened', 'eventCountdown', 'lobbyClosed', 'heartbeat'];
    if (!userSession.isAuthenticated && guestAllowedEvents.includes(eventName)) {
      if (!userSession.currentContext || userSession.currentContext.mode === 'home') {
        return true;
      }
    }
    
    const restrictedEvents = ['quizQuestion', 'timerUpdate', 'answerQueued', 'playerStats', 
                             'eventStarted', 'eventCompleted', 'adBreakStarted', 'adBreakCountdown', 
                             'adBreakEnded', 'immediateWinner', 'lobbyJoined', 'lobbyUpdate', 'lobbyLeft'];
    
    if (!userSession.isAuthenticated && restrictedEvents.includes(eventName)) {
      console.log(`❌ Événement ${eventName} bloqué pour ${clientId}: utilisateur non authentifié`);
      return false;
    }
    
    if (!userSession.currentContext) {
      const basicEvents = ['error', 'forceLogout', 'connectionStatus', 'authenticationConfirmed', 'userStats', 'lobbyStatus', 'nextEvent', 'heartbeat'];
      return basicEvents.includes(eventName);
    }

    if (userSession.currentContext.requiresAuth && !userSession.isAuthenticated) {
      const authEvents = ['error', 'forceLogout', 'connectionStatus', 'heartbeat'];
      return authEvents.includes(eventName);
    }

    const subscription = userSession.currentContext.subscriptions.find(s => s.event === eventName);
    return subscription ? subscription.enabled : false;
  }

  // ======================
  // AUTH & UTILS
  // ======================

  private parseJwt<T = any>(token: string): T | null {
    try {
      const clean = token.replace('Bearer ', '');
      const payload = JSON.parse(atob(clean.split('.')[1]));
      return payload;
    } catch {
      console.warn("Impossible d'extraire le payload JWT");
      return null;
    }
  }

  private extractUserIdFromToken(token: string): string | undefined {
    const payload = this.parseJwt(token);
    return payload?.sub || payload?.userId || payload?.id;
  }

  private extractUserInfoFromToken(token: string): { userId?: string; username?: string; phoneNumber?: string } {
    const payload = this.parseJwt<{
      sub?: string;
      userId?: string;
      id?: string;
      username?: string;
      phoneNumber?: string;
    }>(token);
    return {
      userId: payload?.sub || payload?.userId || payload?.id,
      username: payload?.username,
      phoneNumber: payload?.phoneNumber,
    };
  }

  private async getWinnerInfo(sessionId: string) {
    const userSession = this.userSessions.get(sessionId);
    if (!userSession?.token) return {};
    return this.extractUserInfoFromToken(userSession.token);
  }

 authenticateUser(clientId: string, token: string) {
  console.log(`🔐 Tentative d'authentification pour ${clientId}`);
  
  const userId = this.extractUserIdFromToken(token);
  if (!userId) {
    console.warn(`❌ Impossible d'extraire l'ID utilisateur du token pour ${clientId}`);
    const client = this.server?.sockets.sockets.get(clientId);
    client?.emit('error', { 
      message: 'Token invalide ou mal formé',
      code: 'INVALID_TOKEN'
    });
    return;
  }

  console.log(`🔐 Authentification user ${userId} pour client ${clientId}`);

  const existingClientId = this.userToClientMap.get(userId);
  if (existingClientId && existingClientId !== clientId) {
    console.log(`🔄 Utilisateur ${userId} déjà connecté sur ${existingClientId}, nouvelle session sur ${clientId}`);
    
    const existingSession = this.userSessions.get(existingClientId);
    const existingToken = existingSession?.token;
    
    if (existingToken && existingToken !== token) {
      console.log(`🚨 Tokens différents → Déconnexion ancienne session ${existingClientId}`);
      this.forceDisconnect(existingClientId);
    } else {
      console.log(`🔄 Même token, mise à jour de la session`);
      this.userToClientMap.set(userId, clientId);
    }
  }

    const userSession = this.userSessions.get(clientId) || {
      socketId: clientId,
      token: '',
      userId: undefined,
      isConnected: true,
      isParticipating: false,
      isAuthenticated: false,
      userType: 'guest',
      connectedAt: new Date(),
      lastActivity: new Date(),
    };

    userSession.token = token;
    userSession.userId = userId;
    userSession.isAuthenticated = true;
    userSession.userType = 'authenticated';
    this.userSessions.set(clientId, userSession);
    this.userToClientMap.set(userId, clientId);

    console.log(`✅ User ${userId} authentifié sur client ${clientId}`);
    
    const client = this.server?.sockets.sockets.get(clientId);
    client?.emit('authenticationConfirmed', {
      userId,
      success: true,
      message: 'Authentification réussie'
    });
    
    setTimeout(() => {
      this.sendInitialDataToClient(clientId);
    }, 100);
    
    this.scheduleStatsBroadcast();
  }

  private forceDisconnect(clientId: string) {
    console.log(`🚨🚨🚨 FORCE DISCONNECT DÉCLENCHÉ POUR: ${clientId}`);
    const clientSocket = this.server?.sockets.sockets.get(clientId);
    if (clientSocket?.connected) {
      this.safeEmit(clientId, 'forceLogout', {
        reason: 'Nouvelle connexion détectée depuis un autre navigateur',
        immediate: true,
        timestamp: new Date().toISOString(),
      });
      setTimeout(() => {
        if (this.server?.sockets.sockets.get(clientId)) {
          clientSocket.disconnect(true);
        }
      }, 500);
    }
    this.cleanupSession(clientId);
  }

  private updateUserParticipation(clientId: string, isParticipating: boolean, mode?: 'play' | 'watch') {
    const session = this.userSessions.get(clientId);
    if (session) {
      const wasParticipating = session.isParticipating;
      const previousMode = session.participationMode;
      
      session.isParticipating = isParticipating;
      session.participationMode = mode;
      session.lastActivity = new Date();
      
      if (wasParticipating !== isParticipating || previousMode !== mode) {
        console.log(`🔄 Participation mise à jour pour ${clientId}: ${wasParticipating ? previousMode : 'none'} → ${isParticipating ? mode : 'none'}`);
      }
      
      this.scheduleStatsBroadcast();
    }
  }

  // ======================
  // SOLO & OTHER
  // ======================

  async startSoloQuiz(clientId: string, payload: { theme?: string }) {
    try {
      const { theme } = payload || {};
      const client = this.server?.sockets.sockets.get(clientId);
      const questions = await this.getQuestionsByTheme(theme, 10);
      if (questions.length === 0) {
        client?.emit('error', { message: 'Aucune question trouvée pour ce thème' });
        return;
      }
      const soloQuestions = questions.map((q) => ({
        id: q.id,
        theme: q.theme,
        questionText: q.questionText,
        response1: q.response1,
        response2: q.response2,
        response3: q.response3,
        response4: q.response4,
        correctResponse: q.correctResponse,
      }));
      client?.emit('soloQuestions', { questions: soloQuestions });
      console.log(`Mode solo démarré pour ${clientId} avec ${questions.length} questions (thème: ${theme || 'aléatoire'})`);
    } catch (error) {
      console.error('Erreur lors du démarrage du quiz solo:', error);
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Erreur lors du démarrage du quiz solo. Veuillez réessayer.' });
    }
  }

  async startQuiz(clientId: string, payload: StartQuizPayload) {
    const client = this.server?.sockets.sockets.get(clientId);
    client?.emit('error', { message: 'Le quiz multijoueur ne peut être lancé manuellement' });
  }

  joinOngoingEvent(clientId: string) {
    if (!this.isGlobalQuizActive() || !this.globalQuiz) {
      const client = this.server?.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun événement en cours' });
      return;
    }

    const existingSession = this.quizSessions.get(clientId);
    const client = this.server?.sockets.sockets.get(clientId);
    if (existingSession) {
      if (!existingSession.isWatching && this.shouldBeInWatchMode(clientId)) {
        existingSession.isWatching = true;
        this.updateUserParticipation(clientId, true, 'watch');
      }
      this.sendCurrentQuestion(client!, existingSession);
      client?.emit('joinedInProgress', { mode: existingSession.isWatching ? 'watch' : 'play' });
      return;
    }

    const isFirstQuestionActive = this.globalQuiz.currentQuestionIndex === 0 && this.globalQuiz.timeLeft > 0;
    const isWatching = !isFirstQuestionActive || this.shouldBeInWatchMode(clientId);

    const session: QuizSession = {
      questions: this.globalQuiz.questions,
      currentIndex: this.globalQuiz.currentQuestionIndex,
      score: 0,
      answers: [],
      isWatching,
      timeLimit: this.globalQuiz.timeLimit,
      timeLeft: this.globalQuiz.timeLeft,
      joinedAt: this.globalQuiz.currentQuestionIndex,
    };

    this.quizSessions.set(clientId, session);
    this.globalQuiz.participants.set(clientId, { clientId, score: 0, answers: [] });
    this.updateUserParticipation(clientId, true, isWatching ? 'watch' : 'play');

    this.sendCurrentQuestion(client!, session);
    client?.emit('joinedInProgress', { mode: isWatching ? 'watch' : 'play' });

    this.broadcastUserStats();
  }

  private shouldBeInWatchMode(clientId: string): boolean {
    if (!this.globalQuiz) return true;
    const participant = this.globalQuiz.participants.get(clientId);
    if (participant && participant.answers.length > 0) {
      const lastAnswer = participant.answers[participant.answers.length - 1];
      const currentQuestion = this.globalQuiz.questions[this.globalQuiz.currentQuestionIndex];
      if (currentQuestion && lastAnswer.questionId === currentQuestion.id && !lastAnswer.correct) {
        return true;
      }
    }
    return this.globalQuiz.currentQuestionIndex > 0 || this.globalQuiz.timeLeft <= 0;
  }

  // ======================
  // EVENT UTILS
  // ======================

  private async getQuestionsByTheme(theme?: string, limit = 10): Promise<Question[]> {
    if (theme?.trim()) {
      const questions = await this.questionService.findByTheme(theme);
      if (questions.length > 0) return questions.slice(0, limit);
    }
    return this.questionService.findRandomQuestions(limit);
  }

 private async checkAndOpenLobbyIfNeeded() {
  try {
    if (this.currentLobby || this.isGlobalQuizActive() || !this.isDatabaseConnected) return;
    
    const activeEvents = await this.eventService.findActiveEvents();
    const now = Date.now();
    
    for (const event of activeEvents) {
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 1 * 60 * 1000;
      
      if (eventTime <= now) {
        console.log(`⏭️ Événement ${event.theme} déjà passé - ignoré dans checkAndOpenLobbyIfNeeded`);
        continue;
      }
      
      if (now >= lobbyTime && now <= eventTime) {
        console.log(`🔄 Ouverture automatique du lobby pour: ${event.theme}`);
        await this.openEventLobby(event);
        break;
      }
    }
  } catch (error) {
    console.error('❌ Error in checkAndOpenLobbyIfNeeded:', error);
    this.handleGatewayError(error);
  }
}

  private isGlobalQuizActive(): boolean {
    return this.globalQuiz?.isActive === true;
  }

  public isGlobalQuizActivePublic(): boolean {
    return this.isGlobalQuizActive();
  }

  // ======================
  // AUTOMATIC LOBBY STATUS BROADCASTER
  // ======================

  private checkAndBroadcastLobbyStatus() {
    const currentStatus = this.getCurrentLobbyStatus();
    
    if (!this.lastLobbyStatus || JSON.stringify(currentStatus) !== JSON.stringify(this.lastLobbyStatus)) {
      console.log('📡 Diffusion automatique du statut du lobby:', currentStatus);
      
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'lobbyStatus')) {
          const client = this.server?.sockets.sockets.get(clientId);
          client?.emit('lobbyStatus', currentStatus);
        }
      });
      
      this.lastLobbyStatus = currentStatus;
    }
  }

  private getCurrentLobbyStatus() {
    if (this.currentLobby) {
      return {
        isOpen: true,
        event: {
          id: this.currentLobby.event.id,
          theme: this.currentLobby.event.theme,
          startDate: this.currentLobby.event.startDate,
          numberOfQuestions: this.currentLobby.event.numberOfQuestions,
          minPlayers: this.currentLobby.event.minPlayers
        },
        participants: this.currentLobby.participants.size,
        canJoin: true
      };
    } else if (this.isGlobalQuizActive()) {
      return {
        isOpen: true,
        event: this.globalQuiz?.event ? {
          id: this.globalQuiz.event.id,
          theme: this.globalQuiz.event.theme,
          startDate: this.globalQuiz.event.startDate,
          numberOfQuestions: this.globalQuiz.event.numberOfQuestions,
          minPlayers: this.globalQuiz.event.minPlayers
        } : null,
        participants: this.globalQuiz?.participants.size || 0,
        canJoin: true,
        isQuizInProgress: true
      };
    } else {
      return {
        isOpen: false,
        event: null,
        participants: 0,
        canJoin: false
      };
    }
  }

  // ======================
  // ADMIN & DEBUG
  // ======================

  private async debugEventStatus() {
    const now = new Date();
    const events = await this.eventService.findActiveEvents();
    console.log('=== DEBUG STATUS (3-minute lobby rule) ===');
    console.log(`Current time: ${now.toLocaleString()}`);
    console.log(`Current lobby: ${this.currentLobby ? 'OPEN' : 'CLOSED'}`);
    console.log(`Global quiz active: ${this.isGlobalQuizActive()}`);
    console.log(`Active events: ${events.length}`);
    
    for (const event of events) {
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 1 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      const nowTime = now.getTime();
      
      console.log(`--- Event: ${event.theme} ---`);
      console.log(`ID: ${event.id}`);
      console.log(`Event time: ${new Date(eventTime).toLocaleString()}`);
      console.log(`Lobby should open at: ${new Date(lobbyTime).toLocaleString()}`);
      console.log(`Lobby open: ${event.lobbyOpen}`);
      console.log(`In 3-minute window: ${nowTime >= lobbyTime && nowTime <= endTime}`);
      console.log(`Time until lobby: ${Math.round((lobbyTime - nowTime) / 1000)}s`);
    }
  }

  private async emergencyLobbyCheck() {
    try {
      if (!this.isDatabaseConnected) return;
      
      console.log("🚨 EMERGENCY LOBBY CHECK (3-minute rule)");
      if (this.currentLobby || this.isGlobalQuizActive()) return;

      const eventsReady = await this.eventService.getEventsReadyForLobby();
      if (eventsReady.length > 0) {
        console.log(`⚠️ ALERT: ${eventsReady.length} event(s) within 3-minute lobby window but no lobby open!`);
        for (const event of eventsReady) {
          const now = Date.now();
          const eventTime = new Date(event.startDate).getTime();
          const timeUntilEvent = Math.round((eventTime - now) / 1000);
          
          if (timeUntilEvent <= 180 && timeUntilEvent > 0) {
            console.log(`🔧 CORRECTION: Force opening lobby for "${event.theme}" (starts in ${timeUntilEvent}s)`);
            await this.openEventLobby(event);
            this.safeBroadcast('emergencyLobbyOpened', {
              event: this.formatEvent(event),
              message: 'Lobby automatically opened - event starting soon!',
            });
            break;
          }
        }
      }
    } catch (error) {
      console.error("❌ Error during emergency check:", error);
      this.handleGatewayError(error);
    }
  }

  private async cleanupExpiredEvents() {
    try {
      const now = Date.now();
      const activeEvents = await this.eventService.findActiveEvents();
      for (const event of activeEvents) {
        const eventTime = new Date(event.startDate).getTime();
        const maxWindow = eventTime + 2 * 60 * 1000;
        if (now > maxWindow && !event.isCompleted) {
          console.log(`🧹 Nettoyage automatique: ${event.theme}`);
          await this.eventService.updateEvent(event.id, { isCompleted: true });
        }
      }
    } catch (error) {
      console.error('❌ Erreur lors du nettoyage:', error);
    }
  }

  async forceEventCheck() {
    console.log('🔄 VÉRIFICATION FORCÉE DEMANDÉE');
    await this.checkAndOpenLobbyIfNeeded();
    await this.emergencyLobbyCheck();
  }

  async forceEventUpdate(eventId: string) {
    console.log(`🔄 MISE À JOUR FORCÉE DE L'ÉVÉNEMENT: ${eventId}`);
    if (this.currentLobby && this.currentLobby.event.id === eventId) {
      this.destroyCurrentLobby("Mise à jour forcée de l'événement");
    }
    const events = await this.eventService.findActiveEvents();
    const updatedEvent = events.find((e) => e.id === eventId);
    if (updatedEvent) {
      await this.handleEventUpdated(updatedEvent);
    }
  }

  // ======================
  // DEBUG & MONITORING
  // ======================

  debugUserContexts(): void {
    console.log('=== DEBUG CONTEXTES UTILISATEUR ===');
    console.log(`Total sessions: ${this.userSessions.size}`);
    
    this.userSessions.forEach((session, clientId) => {
      const context = session.currentContext;
      console.log(`Client ${clientId}:`, {
        authenticated: session.isAuthenticated,
        userType: session.userType,
        participating: session.isParticipating,
        participationMode: session.participationMode,
        context: context ? {
          mode: context.mode,
          isSolo: context.isSolo,
          isInLobby: context.isInLobby,
          isInQuiz: context.isInQuiz,
          lastUpdated: context.lastUpdated || new Date(),
          enabledEvents: context.subscriptions.filter(s => s.enabled).length,
          disabledEvents: context.subscriptions.filter(s => !s.enabled).length
        } : 'NO_CONTEXT'
      });
    });
  }

  debugClientSubscriptions(clientId: string): void {
    const session = this.userSessions.get(clientId);
    if (!session) {
      console.log(`❌ Client ${clientId} non trouvé`);
      return;
    }

    console.log(`=== DEBUG ABONNEMENTS CLIENT ${clientId} ===`);
    console.log('Session:', {
      authenticated: session.isAuthenticated,
      userType: session.userType,
      context: session.currentContext?.mode || 'NO_CONTEXT'
    });

    if (session.currentContext) {
      console.log('Abonnements:');
      session.currentContext.subscriptions.forEach(sub => {
        const status = sub.enabled ? '✅' : '❌';
        console.log(`  ${status} ${sub.event}`);
      });
    }
  }

  debugEventBroadcast(eventName: string, testData: any = { test: true }): void {
    console.log(`=== DEBUG BROADCAST EVENT: ${eventName} ===`);
    let sentCount = 0;
    let blockedCount = 0;

    this.userSessions.forEach((session, clientId) => {
      const shouldReceive = this.shouldReceiveEvent(clientId, eventName);
      if (shouldReceive) {
        const client = this.server?.sockets.sockets.get(clientId);
        client?.emit(eventName, { ...testData, debugMode: true });
        sentCount++;
        console.log(`  ✅ Envoyé à ${clientId} (mode: ${session.currentContext?.mode || 'NO_CONTEXT'})`);
      } else {
        blockedCount++;
        console.log(`  ❌ Bloqué pour ${clientId} (mode: ${session.currentContext?.mode || 'NO_CONTEXT'})`);
      }
    });

    console.log(`Résultat: ${sentCount} envoyés, ${blockedCount} bloqués`);
  }

  getContextSummary(): any {
    const summary = {
      totalSessions: this.userSessions.size,
      contextModes: {} as any,
      authenticationStatus: {
        authenticated: 0,
        guest: 0
      }
    };

    this.userSessions.forEach((session) => {
      const mode = session.currentContext?.mode || 'NO_CONTEXT';
      summary.contextModes[mode] = (summary.contextModes[mode] || 0) + 1;

      if (session.isAuthenticated) {
        summary.authenticationStatus.authenticated++;
      } else {
        summary.authenticationStatus.guest++;
      }
    });

    return summary;
  }

  getUserSession(clientId: string): UserSession | undefined {
    return this.userSessions.get(clientId);
  }

  isUserAuthenticated(clientId: string): boolean {
    const session = this.userSessions.get(clientId);
    return session?.isAuthenticated || false;
  }

  private sendInitialDataToClient(clientId: string): void {
    console.log(`📡 Envoi des données initiales au client ${clientId}`);
    
    const client = this.server?.sockets.sockets.get(clientId);
    if (!client) return;

    const stats = this.getUserStats();
    client.emit('userStats', stats);
    console.log(`📊 Stats envoyées au client ${clientId}:`, stats);
    
    const lobbyStatus = this.getCurrentLobbyStatus();
    client.emit('lobbyStatus', lobbyStatus);
    console.log(`🏠 Statut lobby envoyé au client ${clientId}:`, lobbyStatus);
    
    this.sendNextEventIfAllowed(clientId);
  }

  sendUserStatsToClient(clientId: string): void {
    const client = this.server?.sockets.sockets.get(clientId);
    if (!client) return;

    const stats = this.getUserStats();
    client.emit('userStats', stats);
    console.log(`📊 Stats utilisateur envoyées à ${clientId}:`, stats);
  }

  sendLobbyStatusToClient(clientId: string): void {
    const client = this.server?.sockets.sockets.get(clientId);
    if (!client) return;
    
    const status = this.getCurrentLobbyStatus();
    client.emit('lobbyStatus', status);
    console.log(`🏠 Statut lobby envoyé à ${clientId}:`, status);
  }

  sendNextEventToClient(clientId: string): void {
    this.sendNextEventIfAllowed(clientId);
  }

private async sendNextEventIfAllowed(clientId: string): Promise<void> {
  const client = this.server?.sockets.sockets.get(clientId);
  if (!client) return;

  if (this.currentLobby || this.isGlobalQuizActive()) {
    console.log(`nextEvent bloqué pour ${clientId}: lobby ou quiz actif`);
    return;
  }

  try {
    const nextEvent = await this.eventService.getNextEvent();
    if (!nextEvent) {
      console.log(`Aucun prochain événement pour ${clientId}`);
      return;
    }

    const now = Date.now();
    const eventTime = new Date(nextEvent.startDate).getTime();
    const lobbyOpenTime = eventTime - 1 * 60 * 1000;

    if (eventTime <= now) {
      console.log(`nextEvent ignoré pour ${clientId}: événement déjà passé`);
      return;
    }

    if (now >= lobbyOpenTime) {
      console.log(`nextEvent ignoré pour ${clientId}: événement commence dans ≤1 min`);
      return;
    }

    client.emit('nextEvent', this.formatEvent(nextEvent));
    console.log(`✅ nextEvent envoyé à ${clientId}: ${nextEvent.theme} à ${new Date(eventTime).toLocaleTimeString()}`);
  } catch (error) {
    console.error('Erreur lors de l\'envoi de nextEvent:', error);
  }
}

  getUserAuthInfo(clientId: string): { isAuthenticated: boolean; userId?: string; userType?: string } {
    const session = this.userSessions.get(clientId);
    return {
      isAuthenticated: session?.isAuthenticated || false,
      userId: session?.userId,
      userType: session?.userType || 'guest'
    };
  }

  getHealthStats(): any {
    return {
      userSessions: this.userSessions.size,
      quizSessions: this.quizSessions.size,
      currentLobby: this.currentLobby ? {
        event: this.currentLobby.event.theme,
        participants: this.currentLobby.participants.size
      } : null,
      globalQuiz: this.globalQuiz ? {
        isActive: this.globalQuiz.isActive,
        currentQuestion: this.globalQuiz.currentQuestionIndex,
        totalQuestions: this.globalQuiz.questions.length,
        participants: this.globalQuiz.participants.size
      } : null,
      databaseConnected: this.isDatabaseConnected,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime()
    };
  }

  private safeEmit(clientId: string, event: string, data: any): void {
    if (!this.server) {
      console.warn(`❌ Server not available for emit: ${event} to ${clientId}`);
      return;
    }
    
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit(event, data);
  }

  private safeBroadcast(event: string, data: any, filter?: (clientId: string) => boolean): void {
    if (!this.server) {
      console.warn(`❌ Server not available for broadcast: ${event}`);
      return;
    }

    this.userSessions.forEach((session, clientId) => {
      if (!filter || filter(clientId)) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit(event, data);
      }
    });
  }
}