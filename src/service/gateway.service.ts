import { Injectable, OnModuleDestroy } from '@nestjs/common';
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
export class GatewayService implements OnModuleDestroy {
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
  private statsPendingBroadcast = false;
  private lastLobbyStatus: any = null;

  private server: Server;

  constructor(
    private readonly questionService: QuestionService,
    private readonly eventService: EventService,
    private readonly usersService: UsersService,
  ) {
    this.initializeScheduling();
    this.startStatsScheduler();
  }

  setServer(server: Server) {
    this.server = server;
  }

  onModuleDestroy() {
    this.cleanupAllTimers();
    this.cleanupAllSessions();
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

  // Main event scheduler with error handling
  this.eventCheckInterval = setInterval(async () => {
    if (this.currentLobby || this.isGlobalQuizActive()) return;
    await this.checkAndOpenLobbyIfNeeded();
  }, 10000);

  // Backup scheduler - vérifie toutes les 30 secondes
 setInterval(async () => {
  try {
    if (this.currentLobby || this.isGlobalQuizActive()) return;
    
    const eventsReady = await this.eventService.getEventsReadyForLobby();
    for (const event of eventsReady) {
      const now = Date.now();
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 1 * 60 * 1000; // 3 minutes avant
      const endTime = eventTime + 2 * 60 * 1000;
      
      if (now >= lobbyTime && now <= endTime) {
        /* console.log(`🔄 BACKUP: Ouverture automatique du lobby pour: ${event.theme}`); */
        await this.openEventLobby(event);
        break;
      }
    }
  } catch (error) {
    //console.error('❌ Error in event scheduler:', error);
    this.handleGatewayError(error);
  }
}, 15000);

  // Automatic lobby status broadcaster
  this.lobbyStatusInterval = setInterval(() => {
    this.checkAndBroadcastLobbyStatus();
  }, 20000);
}
private handleGatewayError(error: any): void {
  console.error('🚨 Gateway error:', error);
  this.isDatabaseConnected = false;
  
  // Try to recover
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
    const stats = this.getPlayerStats();
    let sentCount = 0;
    
    // Envoyer uniquement aux utilisateurs en mode quiz/online
    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'playerStats')) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('playerStats', stats);
        sentCount++;
      }
    });
    
    if (sentCount > 0) {
    /*   console.log(`📊 Stats joueurs envoyées à ${sentCount} clients:`, stats); */
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
    const stats = this.getUserStats();
    let sentCount = 0;
    
    // Envoyer uniquement aux utilisateurs qui ont userStats activé dans leur contexte
    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'userStats')) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('userStats', stats);
        sentCount++;
      }
    });
    
    if (sentCount > 0) {
   /*    console.log(`📊 Stats utilisateurs envoyées à ${sentCount} clients:`, stats); */
    }
  }

  // ======================
  // LOBBY MANAGEMENT
  // ======================

  private async openEventLobby(event: Event) {
    if (this.currentLobby || this.isGlobalQuizActive()) return;

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

    // Envoyer uniquement aux utilisateurs en mode home
    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'lobbyOpened')) {
        const client = this.server.sockets.sockets.get(clientId);
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

    // Trigger immediate status broadcast
    this.checkAndBroadcastLobbyStatus();
  }

  private startEventCountdown() {
    if (!this.currentLobby) return;

    const update = () => {
      if (!this.currentLobby) return;
      const now = Date.now();
      const eventTime = new Date(this.currentLobby.event.startDate).getTime();
      const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));

      // Envoyer le countdown uniquement aux utilisateurs en mode home
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'eventCountdown')) {
          const client = this.server.sockets.sockets.get(clientId);
          client?.emit('eventCountdown', {
            timeLeft,
            participants: this.currentLobby?.participants.size || 0,
            minPlayers: this.currentLobby?.event.minPlayers || 0,
          });
        }
      });

      if (timeLeft <= 0) this.startEventIfReady();
    };

    update();
    if (this.currentLobby) {
      this.currentLobby.countdownTimer = setInterval(update, 1000);
    }
  }

  private async startEventIfReady() {
    if (!this.currentLobby) return;

    clearInterval(this.currentLobby.countdownTimer);
    const { participants, event } = this.currentLobby;

    if (participants.size > 0) {
      const lobbyParticipants = new Set(participants);
      await this.startEventQuiz(event, lobbyParticipants);
    } else {
      // Envoyer l'annulation d'événement aux utilisateurs en mode quiz
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'eventCancelled')) {
          const client = this.server.sockets.sockets.get(clientId);
          client?.emit('eventCancelled', {
            reason: 'Aucun joueur présent',
            required: event.minPlayers,
            actual: participants.size,
          });
        }
      });
    }

    this.currentLobby = null;
    this.initializeNextEvent();
  }

  joinLobby(clientId: string) {
    // Permettre de rejoindre même si un quiz est en cours (pas encore terminé)
    if (!this.currentLobby && !this.isGlobalQuizActive()) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    // Si un quiz est en cours, rejoindre automatiquement
    if (this.isGlobalQuizActive() && !this.currentLobby) {
      this.joinOngoingEvent(clientId);
      return;
    }

    const wasAlreadyInLobby = this.currentLobby!.participants.has(clientId);
    this.currentLobby!.participants.add(clientId);

   /*  console.log(`Joueur ${clientId} ${wasAlreadyInLobby ? 'déjà dans' : 'a rejoint'} le lobby. Total: ${this.currentLobby!.participants.size}`); */
    
    const client = this.server.sockets.sockets.get(clientId);
    
    // Envoyer les infos du lobby au client qui vient de rejoindre
    client?.emit('lobbyJoined', {
      event: this.currentLobby!.event,
      participants: this.currentLobby!.participants.size,
      minPlayers: this.currentLobby!.event.minPlayers
    });
    
    // Calculer et envoyer le countdown actuel
    const now = Date.now();
    const eventTime = new Date(this.currentLobby!.event.startDate).getTime();
    const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));
    
    client?.emit('eventCountdown', {
      timeLeft,
      participants: this.currentLobby!.participants.size,
      minPlayers: this.currentLobby!.event.minPlayers
    });
    
    // Diffuser la mise à jour à tous les autres participants
    this.broadcastLobbyUpdate();
  }

  leaveLobby(clientId: string) {
    if (!this.currentLobby) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    if (this.currentLobby.participants.delete(clientId)) {
    /*   console.log(`Joueur ${clientId} a quitté le lobby. Total: ${this.currentLobby.participants.size}`); */
      this.broadcastLobbyUpdate();
    }

    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('lobbyLeft', {
      success: true,
      participants: this.currentLobby.participants.size,
    });
  }

  private broadcastLobbyUpdate() {
    if (!this.currentLobby) return;
    
    // Envoyer les mises à jour du lobby aux utilisateurs en mode home et quiz
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
    /* console.log(`🔄 Événement modifié détecté: ${updatedEvent.theme}`); */
    const now = new Date().getTime();
    const eventTime = new Date(updatedEvent.startDate).getTime();
    const maxWindow = eventTime + 2 * 60 * 1000;
  
    if (now > maxWindow && !updatedEvent.isCompleted) {
      console.log(
        `⚠️ Événement ${updatedEvent.theme} expiré - suppression automatique`,
      );
      await this.eventService.updateEvent(updatedEvent.id, { isCompleted: true });
      this.server.emit('eventExpired', {
        id: updatedEvent.id,
        theme: updatedEvent.theme,
      });
      return;
    }
  
    this.broadcastNextEvent(updatedEvent);
  
    if (this.currentLobby && this.currentLobby.event.id === updatedEvent.id) {
      console.log(`🔄 REMPLACEMENT du lobby existant`);
      // ✅ CORRECTION : Vérifier que currentLobby n'est pas null AVANT d'accéder à .participants
      const currentParticipants = new Set(this.currentLobby.participants);
      this.destroyCurrentLobby('Événement modifié - recréation du lobby');
  
      const newEventTime = new Date(updatedEvent.startDate).getTime();
      const newLobbyTime = newEventTime - 1 * 60 * 1000;
      const newEndTime = newEventTime + 2 * 60 * 1000;
  
      if (now >= newLobbyTime && now <= newEndTime) {
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
        this.server.emit('lobbyOpened', {
          event: {
            id: updatedEvent.id,
            theme: updatedEvent.theme || 'Questions Aléatoires',
            numberOfQuestions: updatedEvent.numberOfQuestions,
            startDate: updatedEvent.startDate,
            minPlayers: updatedEvent.minPlayers,
          },
          isRecreated: true,
        });
        this.server.emit('lobbyStatus', { isOpen: true, event: updatedEvent });
        const timeLeft = Math.max(0, Math.floor((newEventTime - now) / 1000));
        // Envoyer le countdown uniquement aux utilisateurs en mode home
        this.userSessions.forEach((session, clientId) => {
          if (this.shouldReceiveEvent(clientId, 'eventCountdown')) {
            const client = this.server.sockets.sockets.get(clientId);
            client?.emit('eventCountdown', {
              timeLeft,
              participants: currentParticipants.size,
              minPlayers: updatedEvent.minPlayers,
            });
          }
        });
       /*  console.log(
          `✅ NOUVEAU lobby créé avec ${currentParticipants.size} participants`,
        ); */
      } else {
        /* console.log(`❌ Nouveau timing invalide - lobby détruit sans recréation`); */
      }
    } else if (!this.currentLobby && !this.isGlobalQuizActive()) {
      const newEventTime = new Date(updatedEvent.startDate).getTime();
      const newLobbyTime = newEventTime - 2 * 60 * 1000;
      const newEndTime = newEventTime + 2 * 60 * 1000;
      if (now >= newLobbyTime && now <= newEndTime) {
        console.log(`🚀 Ouverture d'un nouveau lobby suite à la modification`);
        await this.openEventLobby(updatedEvent);
      }
    }
  
    this.server.emit('eventUpdated', {
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
    this.server.emit('eventDeleted', { id: eventId });
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
    // Envoyer le prochain événement uniquement si aucun lobby ouvert ET aucun quiz en cours
    if (!this.currentLobby && !this.isGlobalQuizActive()) {
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'nextEvent')) {
          const client = this.server.sockets.sockets.get(clientId);
          client?.emit('nextEvent', this.formatEvent(event));
        }
      });
    }
  }

  private async initializeNextEvent() {
    const nextEvent = await this.eventService.getNextEvent();
    if (nextEvent) this.scheduleEventCountdown(nextEvent);
  }

private scheduleEventCountdown(event: Event) {
  try {
    const now = Date.now();
    const eventTime = new Date(event.startDate).getTime();
    const lobbyTime = eventTime - 1 * 60 * 1000; // 3 minutes before

    if (now >= lobbyTime && !event.lobbyOpen) {
      this.openEventLobby(event);
    } else if (lobbyTime > now) {
      // Schedule lobby opening for exactly 3 minutes before event
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

private async checkPendingEvents() {
  if (this.currentLobby || this.isGlobalQuizActive()) return;
  const eventsReady = await this.eventService.getEventsReadyForLobby();
  for (const event of eventsReady) {
    const now = Date.now();
    const eventTime = new Date(event.startDate).getTime();
    const lobbyTime = eventTime - 1 * 60 * 1000; // ✅ CONSISTENT: 3 minutes
    if (now >= lobbyTime) {
      await this.openEventLobby(event);
      break;
    }
  }
}

  // ======================
  // GLOBAL QUIZ
  // ======================

  private async startEventQuiz(event: Event, participants: Set<string>) {
    const questions = await this.getQuestionsByTheme(event.theme, event.numberOfQuestions);
    this.globalQuiz = {
      isActive: true,
      currentQuestionIndex: 0,
      questions,
      timeLimit: 15,
      timeLeft: 15,
      event,
      participants: new Map(),
    };

    // Créer les sessions UNIQUEMENT pour les participants du lobby
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

    // Envoyer eventStarted UNIQUEMENT aux participants authentifiés
    for (const clientId of participants) {
      const userSession = this.userSessions.get(clientId);
      if (userSession?.isAuthenticated) {
        const client = this.server.sockets.sockets.get(clientId);
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
    if (!this.globalQuiz) return;
  
    const quiz = this.globalQuiz; // ✅ Capture pour éviter "possibly null" dans les closures
  
    setTimeout(() => {
      this.broadcastCurrentQuestion();
      quiz.timerInterval = setInterval(() => {
        if (!this.globalQuiz) return;
        this.globalQuiz.timeLeft--;
        // Envoyer les mises à jour du timer aux utilisateurs en mode quiz
        this.userSessions.forEach((session, clientId) => {
          if (this.shouldReceiveEvent(clientId, 'timerUpdate')) {
            const client = this.server.sockets.sockets.get(clientId);
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
        this.handleGlobalTimeExpired();
      }, quiz.timeLimit * 1000);
    }, 1000);
  }

  private broadcastCurrentQuestion() {
    if (!this.globalQuiz) return;
  
    const { currentQuestionIndex, timeLeft } = this.globalQuiz;
  
    // Envoyer les questions UNIQUEMENT aux participants du lobby
    this.quizSessions.forEach((session, clientId) => {
      // Vérifier que le client était dans le lobby au moment du démarrage
      if (!this.globalQuiz?.participants.has(clientId)) return;
      
      const client = this.server.sockets.sockets.get(clientId);
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
    const client = this.server.sockets.sockets.get(clientId);
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
    if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

    let winnerSessionId: string | null = null;
    let winnerUsername: string | null = null;
    let winnerPhone: string | null = null;

    if (this.globalQuiz.event && this.globalQuiz.participants.size > 0) {
      const participants = Array.from(this.globalQuiz.participants.values())
        .filter((p) => p.lastCorrectAnswerTime)
        .sort((a, b) => a.lastCorrectAnswerTime! - b.lastCorrectAnswerTime!);
      if (participants.length > 0) {
        winnerSessionId = participants[0].clientId;
        const winnerInfo = await this.getWinnerInfo(winnerSessionId);
        winnerUsername = winnerInfo.username || null;
        winnerPhone = winnerInfo.phoneNumber || null;

        if (winnerPhone) {
          await this.eventService.completeEvent(this.globalQuiz.event.id, winnerPhone);
        } else {
          await this.eventService.completeEvent(this.globalQuiz.event.id, winnerSessionId);
        }

        // Envoyer l'événement terminé aux utilisateurs en mode quiz
        this.userSessions.forEach((session, clientId) => {
          if (this.shouldReceiveEvent(clientId, 'eventCompleted')) {
            const client = this.server.sockets.sockets.get(clientId);
            client?.emit('eventCompleted', {
              eventId: this.globalQuiz?.event?.id || '',
              winner: winnerUsername || winnerSessionId,
              winnerPhone,
              winnerDisplay: winnerUsername ? `🏆 ${winnerUsername}` : `Session: ${winnerSessionId}`,
            });
          }
        });
      }
    }

    this.quizSessions.forEach((session, clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        client.emit('quizCompleted', {
          score: session.score,
          totalQuestions: session.questions.length,
          answers: session.answers,
          joinedAt: session.joinedAt,
          winner: winnerUsername || winnerSessionId,
          isWinner: clientId === winnerSessionId,
        });
      }
    });

    setTimeout(() => this.server.disconnectSockets(true), 5000);
    this.globalQuiz = null;
    this.quizSessions.clear();
    this.currentLobby = null;
  }

  private startAdBreakBeforeFinalQuestion() {
    if (!this.globalQuiz) return;
    console.log('📺 Démarrage de la pause publicitaire avant la dernière question');

    // Envoyer la pause publicitaire aux utilisateurs en mode quiz
    this.userSessions.forEach((session, clientId) => {
      if (this.shouldReceiveEvent(clientId, 'adBreakStarted')) {
        const client = this.server.sockets.sockets.get(clientId);
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
      // Envoyer le countdown de la pause publicitaire aux utilisateurs en mode quiz
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'adBreakCountdown')) {
          const client = this.server.sockets.sockets.get(clientId);
          client?.emit('adBreakCountdown', { timeLeft: countdown });
        }
      });
      if (countdown <= 0) {
        clearInterval(adCountdownInterval);
        // Envoyer la fin de la pause publicitaire aux utilisateurs en mode quiz
        this.userSessions.forEach((session, clientId) => {
          if (this.shouldReceiveEvent(clientId, 'adBreakEnded')) {
            const client = this.server.sockets.sockets.get(clientId);
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
      if (winnerPhone) {
        await this.eventService.completeEvent(this.globalQuiz.event.id, winnerPhone);
      } else {
        await this.eventService.completeEvent(this.globalQuiz.event.id, clientId);
      }

      // Envoyer le gagnant immédiat aux utilisateurs en mode quiz
      this.userSessions.forEach((session, sessionClientId) => {
        if (this.shouldReceiveEvent(sessionClientId, 'immediateWinner')) {
          const client = this.server.sockets.sockets.get(sessionClientId);
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
      const client = this.server.sockets.sockets.get(sessionClientId);
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

    setTimeout(() => this.server.disconnectSockets(true), 5000);
    this.globalQuiz = null;
    this.quizSessions.clear();
    this.currentLobby = null;
  }

  // ======================
  // CONNECTION / DISCONNECTION
  // ======================

  handleConnection(clientId: string) {
   /*  console.log(`🔌 Client connected: ${clientId}`); */
    
    // Créer la session utilisateur
    this.userSessions.set(clientId, {
      socketId: clientId,
      token: '',
      isConnected: true,
      isParticipating: false,
      isAuthenticated: false,
      userType: 'guest',
      connectedAt: new Date(),
    });

    // Émission automatique des données initiales après connexion
    setTimeout(() => {
      this.sendInitialDataToClient(clientId);
    }, 500); // Petit délai pour s'assurer que le client est prêt

    this.checkAndOpenLobbyIfNeeded();
    this.scheduleStatsBroadcast();
  }

  handleDisconnection(clientId: string) {
   /*  console.log(`Client disconnected: ${clientId}`); */
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
    if (this.eventCheckInterval) clearInterval(this.eventCheckInterval);
    if (this.nextEventTimer) clearTimeout(this.nextEventTimer);
    if (this.statsUpdateInterval) clearInterval(this.statsUpdateInterval);
    if (this.lobbyStatusInterval) clearInterval(this.lobbyStatusInterval);
  }

  private destroyCurrentLobby(reason: string = 'Lobby détruit') {
    if (!this.currentLobby) return;

    if (this.currentLobby.countdownTimer) clearInterval(this.currentLobby.countdownTimer);
    if (this.currentLobby.lobbyTimer) clearTimeout(this.currentLobby.lobbyTimer);

    const eventId = this.currentLobby.event.id;
    this.currentLobby = null;

    this.server.emit('lobbyClosed', { reason, eventId });
    // Trigger immediate status broadcast
    this.checkAndBroadcastLobbyStatus();
  }

  // ======================
  // CONTEXT MANAGEMENT
  // ======================

  setUserContext(clientId: string, payload: { mode: string; isSolo?: boolean; isInLobby?: boolean; isInQuiz?: boolean }) {
    const userSession = this.userSessions.get(clientId);
    if (!userSession) {
     /*  console.warn(`Tentative de définir le contexte pour un utilisateur inexistant: ${clientId}`); */
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { 
        message: 'Session utilisateur non trouvée. Veuillez vous reconnecter.',
        code: 'SESSION_NOT_FOUND',
        requiredAction: 'RECONNECT'
      });
      return;
    }

    // Validation stricte de l'authentification selon le mode
    const authValidation = this.validateAuthenticationForMode(payload.mode as any, payload, userSession);
    if (!authValidation.isValid) {
      console.warn(`⚠️ Accès refusé pour ${clientId}: ${authValidation.reason}`);
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', authValidation.error);
      return;
    }

    // Nettoyer le contexte précédent si nécessaire
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
    
    // Log détaillé pour le debugging
    console.log(`✅ Événements ACTIVÉS pour ${payload.mode}: [${enabledEvents.join(', ')}]`);
    console.log(`❌ Événements DÉSACTIVÉS pour ${payload.mode}: [${disabledEvents.join(', ')}]`);

    // Envoyer immédiatement les données pertinentes selon le contexte
    this.sendContextualData(clientId, userSession.currentContext);
    
    // Confirmer le changement de contexte au client
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('contextSet', {
      mode: payload.mode,
      success: true,
      enabledEvents: contextSubscriptions.filter(s => s.enabled).map(s => s.event)
    });
  }

  /**
   * Valide si l'utilisateur peut accéder au mode demandé selon son statut d'authentification
   */
  private validateAuthenticationForMode(
    mode: 'home' | 'solo' | 'online' | 'quiz', 
    payload: any, 
    userSession: UserSession
  ): { isValid: boolean; reason?: string; error?: any } {
    // Mode home : toujours accessible
    if (mode === 'home') {
      return { isValid: true };
    }

    // Mode solo : toujours accessible (pas d'authentification requise)
    if (mode === 'solo' && payload.isSolo === true) {
      return { isValid: true };
    }

    // Mode online : authentification obligatoire
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

    // Mode quiz : authentification obligatoire pour le multijoueur
    if (mode === 'quiz') {
      // Quiz solo : pas d'authentification requise
      if (payload.isSolo === true) {
        return { isValid: true };
      }
      
      // Quiz multijoueur : authentification obligatoire
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

  /**
   * Détermine si un mode nécessite une authentification
   */
  private doesModeRequireAuth(mode: 'home' | 'solo' | 'online' | 'quiz', payload: any): boolean {
    if (mode === 'home') return false;
    if (mode === 'solo' && payload.isSolo === true) return false;
    if (mode === 'online') return true;
    if (mode === 'quiz' && !payload.isSolo) return true;
    return false;
  }

  /**
   * Nettoie les ressources du contexte précédent
   */
  private cleanupPreviousContext(clientId: string, previousContext: NonNullable<UserContext>): void {
    // Nettoyer les abonnements spécifiques au contexte précédent
    if (previousContext.mode === 'quiz' && previousContext.isInQuiz) {
      // Retirer de la session de quiz si nécessaire
      const session = this.quizSessions.get(clientId);
      if (session && !this.isGlobalQuizActive()) {
        this.quizSessions.delete(clientId);
      }
    }
    
    if (previousContext.mode === 'online' && previousContext.isInLobby) {
      // Retirer du lobby si nécessaire
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
      { event: 'forceLogout', enabled: true }
    ];

    switch (mode) {
      case 'home':
        return [
          ...baseSubscriptions,
          { event: 'userStats', enabled: true },
          { event: 'nextEvent', enabled: true },
          { event: 'lobbyOpened', enabled: true },
          { event: 'lobbyStatus', enabled: true },
          { event: 'eventCountdown', enabled: true },
          { event: 'lobbyClosed', enabled: true },
          { event: 'eventUpdated', enabled: true },
          { event: 'eventDeleted', enabled: true },
          { event: 'eventExpired', enabled: true },
          { event: 'authenticationConfirmed', enabled: true },
          // BLOCAGE STRICT : Aucun événement de jeu en mode home
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
          // BLOCAGE STRICT : Aucun événement multijoueur en mode solo
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
        
        // Si c'est un quiz solo, traiter comme le mode solo
        if (isSolo === true) {
          return [
            ...baseSubscriptions,
            { event: 'soloQuestions', enabled: true },
            // BLOCAGE STRICT pour quiz solo
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
        
        // Mode multijoueur online/quiz - ✅ ENABLE userStats HERE
        const onlineSubscriptions = [
          ...baseSubscriptions,
          { event: 'userStats', enabled: true },  // ✅ ENABLED in online multiplayer
          { event: 'eventStarted', enabled: true },
          { event: 'eventCompleted', enabled: true },
          { event: 'lobbyJoined', enabled: true },
          { event: 'lobbyUpdate', enabled: true },
          { event: 'lobbyLeft', enabled: true },
          { event: 'eventCancelled', enabled: true },
          { event: 'autoStartQuiz', enabled: true },
          { event: 'joinedInProgress', enabled: true },
          { event: 'authenticationConfirmed', enabled: true },
          // BLOCAGE STRICT : Aucun événement home en mode online
          { event: 'nextEvent', enabled: false },
          { event: 'lobbyOpened', enabled: false },
          { event: 'lobbyStatus', enabled: false },
          { event: 'soloQuestions', enabled: false }
        ];
        
        // Activer les événements de lobby seulement si dans le lobby
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
        
        // Activer les événements de quiz seulement si dans le quiz
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
    const client = this.server.sockets.sockets.get(clientId);
    if (!client) return;

    switch (context.mode) {
      case 'home':
        // Envoyer les stats utilisateur
        client.emit('userStats', this.getUserStats());
        
        // Envoyer le prochain événement seulement si aucun lobby ouvert ET aucun quiz en cours
        this.sendNextEventIfAllowed(clientId);
        
        // Envoyer le statut du lobby
        this.sendLobbyStatusToClient(clientId);
        break;
      
      case 'solo':
        // Rien à envoyer immédiatement, attendre startSoloQuiz
        break;
      
      case 'online':
      case 'quiz':
        // ✅ Envoyer les stats utilisateur IMMÉDIATEMENT en mode online
        client.emit('userStats', this.getUserStats());
        
        // Envoyer les stats des joueurs
        client.emit('playerStats', this.getPlayerStats());
        
        // Si un quiz est en cours, rejoindre automatiquement
        if (this.isGlobalQuizActive()) {
          this.joinOngoingEvent(clientId);
        }
        break;
    }
  }



  private shouldReceiveEvent(clientId: string, eventName: string): boolean {
    const userSession = this.userSessions.get(clientId);
    
    // Si pas de session, refuser tous les événements sauf les essentiels
    if (!userSession) {
      const essentialEvents = ['error', 'forceLogout', 'connectionStatus', 'userStats', 'lobbyStatus', 'nextEvent'];
      return essentialEvents.includes(eventName);
    }
    
    // Permettre certains événements pour les utilisateurs non authentifiés en mode home
    const guestAllowedEvents = ['userStats', 'lobbyStatus', 'nextEvent', 'lobbyOpened', 'eventCountdown', 'lobbyClosed'];
    if (!userSession.isAuthenticated && guestAllowedEvents.includes(eventName)) {
      // Vérifier si l'utilisateur est en mode home
      if (!userSession.currentContext || userSession.currentContext.mode === 'home') {
        return true;
      }
    }
    
    // BLOCAGE STRICT: Utilisateurs non authentifiés ne peuvent pas accéder aux modes online/quiz
    const restrictedEvents = ['quizQuestion', 'timerUpdate', 'answerQueued', 'playerStats', 
                             'eventStarted', 'eventCompleted', 'adBreakStarted', 'adBreakCountdown', 
                             'adBreakEnded', 'immediateWinner', 'lobbyJoined', 'lobbyUpdate', 'lobbyLeft'];
    
    if (!userSession.isAuthenticated && restrictedEvents.includes(eventName)) {
     /*  console.log(`❌ Événement ${eventName} bloqué pour ${clientId}: utilisateur non authentifié`); */
      return false;
    }
    
    // Si pas de contexte défini, envoyer les événements de base
    if (!userSession.currentContext) {
      const basicEvents = ['error', 'forceLogout', 'connectionStatus', 'authenticationConfirmed', 'userStats', 'lobbyStatus', 'nextEvent'];
      return basicEvents.includes(eventName);
    }

    // Vérifier l'authentification pour les modes qui la nécessitent
    if (userSession.currentContext.requiresAuth && !userSession.isAuthenticated) {
      const authEvents = ['error', 'forceLogout', 'connectionStatus'];
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
    const userId = this.extractUserIdFromToken(token);
    if (!userId) {
      console.warn(`❌ Impossible d'extraire l'ID utilisateur du token pour ${clientId}`);
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { 
        message: 'Token invalide ou mal formé',
        code: 'INVALID_TOKEN'
      });
      return;
    }

    /* console.log(`🔐 Authentification user ${userId} pour client ${clientId}`); */

    // Vérifier les sessions existantes
    const existingClientId = this.userToClientMap.get(userId);
    if (existingClientId && existingClientId !== clientId) {
      const existingSession = this.userSessions.get(existingClientId);
      const existingToken = existingSession?.token;
      if (existingToken && existingToken !== token) {
       /*  console.log(`🚨 Tokens différents → Déconnexion ancienne session ${existingClientId}`); */
        this.forceDisconnect(existingClientId);
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
    };

    userSession.token = token;
    userSession.userId = userId;
    userSession.isAuthenticated = true;
    userSession.userType = 'authenticated';
    this.userSessions.set(clientId, userSession);
    this.userToClientMap.set(userId, clientId);

    /* console.log(`✅ User ${userId} authentifié sur client ${clientId}`); */
    
    // Confirmer l'authentification au client
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('authenticationConfirmed', {
      userId,
      success: true,
      message: 'Authentification réussie'
    });
    
    // Envoyer immédiatement les données après authentification
    setTimeout(() => {
      this.sendInitialDataToClient(clientId);
    }, 100);
    
    this.scheduleStatsBroadcast();
  }

  private forceDisconnect(clientId: string) {
    console.log(`🚨🚨🚨 FORCE DISCONNECT DÉCLENCHÉ POUR: ${clientId}`);
    const clientSocket = this.server.sockets.sockets.get(clientId);
    if (clientSocket?.connected) {
      this.server.to(clientId).emit('forceLogout', {
        reason: 'Nouvelle connexion détectée depuis un autre navigateur',
        immediate: true,
        timestamp: new Date().toISOString(),
      });
      setTimeout(() => {
        if (this.server.sockets.sockets.get(clientId)) {
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
      
      if (wasParticipating !== isParticipating || previousMode !== mode) {
      /*   console.log(`🔄 Participation mise à jour pour ${clientId}: ${wasParticipating ? previousMode : 'none'} → ${isParticipating ? mode : 'none'}`); */
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
      const client = this.server.sockets.sockets.get(clientId);
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
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Erreur lors du démarrage du quiz solo. Veuillez réessayer.' });
    }
  }

  async startQuiz(clientId: string, payload: StartQuizPayload) {
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('error', { message: 'Le quiz multijoueur ne peut être lancé manuellement' });
  }

  joinOngoingEvent(clientId: string) {
    if (!this.isGlobalQuizActive() || !this.globalQuiz) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun événement en cours' });
      return;
    }

    const existingSession = this.quizSessions.get(clientId);
    const client = this.server.sockets.sockets.get(clientId);
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
      const lobbyTime = eventTime - 1 * 60 * 1000; // 3 minutes before
      
      if (now >= lobbyTime && now <= eventTime + 2 * 60 * 1000) {
       
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

  // Méthode publique pour vérifier l'état du quiz global (utilisée par EventService)
  public isGlobalQuizActivePublic(): boolean {
    return this.isGlobalQuizActive();
  }

  // ======================
  // AUTOMATIC LOBBY STATUS BROADCASTER
  // ======================

  private checkAndBroadcastLobbyStatus() {
    const currentStatus = this.getCurrentLobbyStatus();
    
    // Compare with last status to detect changes
    if (!this.lastLobbyStatus || JSON.stringify(currentStatus) !== JSON.stringify(this.lastLobbyStatus)) {
     /*  console.log('📡 Diffusion automatique du statut du lobby:', currentStatus); */
      
      // Send to users in home mode only
      this.userSessions.forEach((session, clientId) => {
        if (this.shouldReceiveEvent(clientId, 'lobbyStatus')) {
          const client = this.server.sockets.sockets.get(clientId);
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
      // Si un quiz est en cours, permettre de rejoindre
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
    const lobbyTime = eventTime - 1 * 60 * 1000; // 3 minutes before
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
        
        if (timeUntilEvent <= 180 && timeUntilEvent > 0) { // Within 3 minutes
          console.log(`🔧 CORRECTION: Force opening lobby for "${event.theme}" (starts in ${timeUntilEvent}s)`);
          await this.openEventLobby(event);
          this.server.emit('emergencyLobbyOpened', {
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

  /**
   * Méthode de debug pour afficher l'état des contextes utilisateur
   */
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

  /**
   * Méthode de debug pour vérifier les abonnements d'un client
   */
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

  /**
   * Méthode de debug pour tester l'envoi d'événements
   */
  debugEventBroadcast(eventName: string, testData: any = { test: true }): void {
    console.log(`=== DEBUG BROADCAST EVENT: ${eventName} ===`);
    let sentCount = 0;
    let blockedCount = 0;

    this.userSessions.forEach((session, clientId) => {
      const shouldReceive = this.shouldReceiveEvent(clientId, eventName);
      if (shouldReceive) {
        const client = this.server.sockets.sockets.get(clientId);
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

  /**
   * Méthode pour obtenir un résumé des contextes
   */
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
      // Compter par mode de contexte
      const mode = session.currentContext?.mode || 'NO_CONTEXT';
      summary.contextModes[mode] = (summary.contextModes[mode] || 0) + 1;

      // Compter par statut d'authentification
      if (session.isAuthenticated) {
        summary.authenticationStatus.authenticated++;
      } else {
        summary.authenticationStatus.guest++;
      }
    });

    return summary;
  }

  /**
   * Obtient la session d'un utilisateur (pour validation dans le contrôleur)
   */
  getUserSession(clientId: string): UserSession | undefined {
    return this.userSessions.get(clientId);
  }

  /**
   * Vérifie si un utilisateur est authentifié
   */
  isUserAuthenticated(clientId: string): boolean {
    const session = this.userSessions.get(clientId);
    return session?.isAuthenticated || false;
  }

  /**
   * Envoie les données initiales à un client spécifique
   */
  private sendInitialDataToClient(clientId: string): void {
 /*    console.log(`📡 Envoi des données initiales au client ${clientId}`); */
    
    const client = this.server.sockets.sockets.get(clientId);
    if (!client) return;

    // Envoyer les stats utilisateur
    const stats = this.getUserStats();
    client.emit('userStats', stats);
    /* console.log(`📊 Stats envoyées au client ${clientId}:`, stats); */
    
    // Envoyer le statut du lobby
    const lobbyStatus = this.getCurrentLobbyStatus();
    client.emit('lobbyStatus', lobbyStatus);
   /*  console.log(`🏠 Statut lobby envoyé au client ${clientId}:`, lobbyStatus); */
    
    // Envoyer le prochain événement si disponible
    this.sendNextEventIfAllowed(clientId);
  }

  /**
   * Envoie les stats utilisateur à un client spécifique
   */
  sendUserStatsToClient(clientId: string): void {
    const client = this.server.sockets.sockets.get(clientId);
    if (!client) return;

    const stats = this.getUserStats();
    client.emit('userStats', stats);
   /*  console.log(`📊 Stats utilisateur envoyées à ${clientId}:`, stats); */
  }

  /**
   * Envoie le statut du lobby à un client spécifique
   */
  sendLobbyStatusToClient(clientId: string): void {
    const client = this.server.sockets.sockets.get(clientId);
    if (!client) return;
    
    const status = this.getCurrentLobbyStatus();
    client.emit('lobbyStatus', status);
    console.log(`🏠 Statut lobby envoyé à ${clientId}:`, status);
  }

  /**
   * Envoie le prochain événement à un client spécifique
   */
  sendNextEventToClient(clientId: string): void {
    this.sendNextEventIfAllowed(clientId);
  }

  /**
   * Envoie nextEvent seulement si aucun lobby ouvert ET aucun quiz en cours
   */
  private sendNextEventIfAllowed(clientId: string): void {
    const client = this.server.sockets.sockets.get(clientId);
    if (!client) return;

    // Ne jamais envoyer nextEvent si un lobby est ouvert ou va l'être
    if (this.currentLobby || this.isGlobalQuizActive()) {
     /*  console.log(`🚫 nextEvent bloqué pour ${clientId}: lobby=${!!this.currentLobby}, quiz=${this.isGlobalQuizActive()}`); */
      return;
    }

    this.eventService.getNextEvent().then(event => {
      if (event) {
        client.emit('nextEvent', this.formatEvent(event));
       /*  console.log(`📅 Prochain événement envoyé à ${clientId}:`, event.theme); */
      } else {
       /*  console.log(`🚫 Aucun prochain événement disponible pour ${clientId}`); */
      }
    });
  }

  /**
   * Obtient les informations d'authentification d'un utilisateur
   */
  getUserAuthInfo(clientId: string): { isAuthenticated: boolean; userId?: string; userType?: string } {
    const session = this.userSessions.get(clientId);
    return {
      isAuthenticated: session?.isAuthenticated || false,
      userId: session?.userId,
      userType: session?.userType || 'guest'
    };
  }
}