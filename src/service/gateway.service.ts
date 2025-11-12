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
}

@Injectable()
export class GatewayService implements OnModuleDestroy {
  private quizSessions = new Map<string, QuizSession>();
  private globalQuiz: GlobalQuiz | null = null;
  private currentLobby: EventLobby | null = null;
  private userToClientMap = new Map<string, string>();
  private userSessions = new Map<string, UserSession>();

  private eventCheckInterval?: NodeJS.Timeout;
  private nextEventTimer?: NodeJS.Timeout;
  private statsUpdateInterval?: NodeJS.Timeout;
  private statsPendingBroadcast = false;

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
    setTimeout(() => this.checkAndOpenLobbyIfNeeded(), 1000);
    setInterval(() => this.debugEventStatus(), 30000);
    setInterval(() => this.emergencyLobbyCheck(), 60000);
    setInterval(() => this.cleanupExpiredEvents(), 30000);

    // Main event scheduler
    this.eventCheckInterval = setInterval(async () => {
      if (this.currentLobby || this.isGlobalQuizActive()) return;
      await this.checkAndOpenLobbyIfNeeded();
    }, 80);

    // Backup scheduler
    setInterval(async () => {
      if (this.currentLobby || this.isGlobalQuizActive()) return;
      const eventsReady = await this.eventService.getEventsReadyForLobby();
      for (const event of eventsReady) {
        const now = Date.now();
        const eventTime = new Date(event.startDate).getTime();
        const lobbyTime = eventTime - 5 * 60 * 1000;
        const endTime = eventTime + 2 * 60 * 1000;
        if (now >= lobbyTime && now <= endTime) {
          console.log(`🔄 BACKUP: Ouverture automatique du lobby pour: ${event.theme}`);
          await this.openEventLobby(event);
          break;
        }
      }
    }, 10000);
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
    this.server.emit('playerStats', this.getPlayerStats());
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
    console.log('📊 STATS UTILISATEURS:', stats);
    this.server.emit('userStats', stats);
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

    this.server.emit('lobbyOpened', {
      event: {
        id: event.id,
        theme: event.theme || 'Questions Aléatoires',
        numberOfQuestions: event.numberOfQuestions,
        startDate: event.startDate,
        minPlayers: event.minPlayers,
      },
    });

    this.server.emit('lobbyStatus', { isOpen: true, event });
  }

  private startEventCountdown() {
    if (!this.currentLobby) return;

    const update = () => {
      if (!this.currentLobby) return;
      const now = Date.now();
      const eventTime = new Date(this.currentLobby.event.startDate).getTime();
      const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));

      this.server.emit('eventCountdown', {
        timeLeft,
        participants: this.currentLobby.participants.size,
        minPlayers: this.currentLobby.event.minPlayers,
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
      this.server.emit('eventCancelled', {
        reason: 'Aucun joueur présent',
        required: event.minPlayers,
        actual: participants.size,
      });
    }

    this.currentLobby = null;
    this.initializeNextEvent();
  }

  joinLobby(clientId: string) {
    if (!this.currentLobby) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    const wasAlreadyInLobby = this.currentLobby.participants.has(clientId);
    this.currentLobby.participants.add(clientId);

    console.log(`Joueur ${clientId} ${wasAlreadyInLobby ? 'déjà dans' : 'a rejoint'} le lobby. Total: ${this.currentLobby.participants.size}`);
    this.broadcastLobbyUpdate();

    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('lobbyJoined', {
      event: this.currentLobby.event,
      participants: this.currentLobby.participants.size,
    });
  }

  leaveLobby(clientId: string) {
    if (!this.currentLobby) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    if (this.currentLobby.participants.delete(clientId)) {
      console.log(`Joueur ${clientId} a quitté le lobby. Total: ${this.currentLobby.participants.size}`);
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
    this.server.emit('lobbyUpdate', {
      participants: this.currentLobby.participants.size,
      minPlayers: this.currentLobby.event.minPlayers,
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
      const newLobbyTime = newEventTime - 5 * 60 * 1000;
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
        this.server.emit('eventCountdown', {
          timeLeft,
          participants: currentParticipants.size,
          minPlayers: updatedEvent.minPlayers,
        });
        console.log(
          `✅ NOUVEAU lobby créé avec ${currentParticipants.size} participants`,
        );
      } else {
        console.log(`❌ Nouveau timing invalide - lobby détruit sans recréation`);
      }
    } else if (!this.currentLobby && !this.isGlobalQuizActive()) {
      const newEventTime = new Date(updatedEvent.startDate).getTime();
      const newLobbyTime = newEventTime - 5 * 60 * 1000;
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
    this.server.emit('nextEvent', this.formatEvent(event));
  }

  private async initializeNextEvent() {
    const nextEvent = await this.eventService.getNextEvent();
    if (nextEvent) this.scheduleEventCountdown(nextEvent);
  }

  private scheduleEventCountdown(event: Event) {
    const now = Date.now();
    const eventTime = new Date(event.startDate).getTime();
    const lobbyTime = eventTime - 5 * 60 * 1000;
    const endTime = eventTime + 2 * 60 * 1000;

    if (now >= lobbyTime && !event.lobbyOpen && now <= endTime) {
      this.openEventLobby(event);
    } else if (lobbyTime > now) {
      this.nextEventTimer = setTimeout(() => this.checkPendingEvents(), lobbyTime - now);
    }

    this.broadcastNextEvent(event);
  }

  private async checkPendingEvents() {
    if (this.currentLobby || this.isGlobalQuizActive()) return;
    const eventsReady = await this.eventService.getEventsReadyForLobby();
    for (const event of eventsReady) {
      const now = Date.now();
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 5 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      if (now >= lobbyTime && now <= endTime) {
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

    this.server.emit('eventStarted', { event: this.formatEvent(event) });
    for (const clientId of participants) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('autoStartQuiz', {
        theme: event.theme,
        limit: event.numberOfQuestions,
        timeLimit: 30,
      });
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
        this.server.emit('timerUpdate', {
          timeLeft: this.globalQuiz.timeLeft,
          ...this.getPlayerStats(),
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
  
    this.quizSessions.forEach((session, clientId) => {
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
    this.broadcastPlayerStats();
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

        this.server.emit('eventCompleted', {
          eventId: this.globalQuiz.event.id,
          winner: winnerUsername || winnerSessionId,
          winnerPhone,
          winnerDisplay: winnerUsername ? `🏆 ${winnerUsername}` : `Session: ${winnerSessionId}`,
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

    this.server.emit('adBreakStarted', {
      duration: 15,
      message: 'Pause publicitaire avant la dernière question',
      isFinalQuestion: true,
    });

    let countdown = 15;
    const adCountdownInterval = setInterval(() => {
      countdown--;
      this.server.emit('adBreakCountdown', { timeLeft: countdown });
      if (countdown <= 0) {
        clearInterval(adCountdownInterval);
        this.server.emit('adBreakEnded');
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

      this.server.emit('immediateWinner', {
        eventId: this.globalQuiz.event.id,
        winner: winnerUsername || clientId,
        winnerPhone,
        winnerDisplay: winnerUsername ? `🏆 ${winnerUsername}` : `Session: ${clientId}`,
        message: 'Première réponse correcte sur la dernière question !',
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
    console.log(`Client connected: ${clientId}`);
    this.userSessions.set(clientId, {
      socketId: clientId,
      token: '',
      isConnected: true,
      isParticipating: false,
      isAuthenticated: false,
      userType: 'guest',
      connectedAt: new Date(),
    });

    this.checkAndOpenLobbyIfNeeded();
    this.sendNextEventInfo(clientId);
    if (this.currentLobby) {
      this.sendLobbyInfo(clientId);
      this.sendEventCountdown(clientId);
    }
    this.broadcastPlayerStats();
    this.scheduleStatsBroadcast();
  }

  handleDisconnection(clientId: string) {
    console.log(`Client disconnected: ${clientId}`);
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

    this.broadcastPlayerStats();
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
  }

  private destroyCurrentLobby(reason: string = 'Lobby détruit') {
    if (!this.currentLobby) return;

    if (this.currentLobby.countdownTimer) clearInterval(this.currentLobby.countdownTimer);
    if (this.currentLobby.lobbyTimer) clearTimeout(this.currentLobby.lobbyTimer);

    const eventId = this.currentLobby.event.id;
    this.currentLobby = null;

    this.server.emit('lobbyClosed', { reason, eventId });
    this.server.emit('lobbyStatus', { isOpen: false, event: null });
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
      console.warn("Impossible d'extraire l'ID utilisateur du token");
      return;
    }

    console.log(`🔐 Authentification user ${userId} pour client ${clientId}`);

    const existingClientId = this.userToClientMap.get(userId);
    if (existingClientId && existingClientId !== clientId) {
      const existingSession = this.userSessions.get(existingClientId);
      const existingToken = existingSession?.token;
      if (existingToken && existingToken !== token) {
        console.log(`🚨 Tokens différents → Déconnexion ancienne session ${existingClientId}`);
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

    console.log(`✅ User ${userId} authentifié sur client ${clientId}`);
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
      session.isParticipating = isParticipating;
      session.participationMode = mode;
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

    this.broadcastPlayerStats();
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
    if (this.currentLobby || this.isGlobalQuizActive()) return;
    const activeEvents = await this.eventService.findActiveEvents();
    const now = Date.now();
    for (const event of activeEvents) {
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 5 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      if (now >= lobbyTime && now <= endTime) {
        await this.openEventLobby(event);
        break;
      }
    }
  }

  private sendNextEventInfo(clientId: string) {
    this.eventService.getNextEvent().then((event) => {
      if (event) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('nextEvent', this.formatEvent(event));
      }
    });
  }

  private sendLobbyInfo(clientId: string) {
    if (!this.currentLobby) return;
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('lobbyOpened', {
      event: {
        id: this.currentLobby.event.id,
        theme: this.currentLobby.event.theme,
        numberOfQuestions: this.currentLobby.event.numberOfQuestions,
        startDate: this.currentLobby.event.startDate,
        minPlayers: this.currentLobby.event.minPlayers,
      },
    });
  }

  private sendEventCountdown(clientId: string) {
    if (!this.currentLobby) return;
    const now = Date.now();
    const eventTime = new Date(this.currentLobby.event.startDate).getTime();
    const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));
    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('eventCountdown', {
      timeLeft,
      participants: this.currentLobby.participants.size,
      minPlayers: this.currentLobby.event.minPlayers,
    });
  }

  private isGlobalQuizActive(): boolean {
    return this.globalQuiz?.isActive === true;
  }

  // ======================
  // ADMIN & DEBUG
  // ======================

  private async debugEventStatus() {
    const now = new Date();
    const events = await this.eventService.findActiveEvents();
    console.log('=== DEBUG STATUS ===');
    console.log(`Heure actuelle: ${now.toLocaleString()}`);
    console.log(`Lobby actuel: ${this.currentLobby ? 'OUVERT' : 'FERMÉ'}`);
    console.log(`Quiz global actif: ${this.isGlobalQuizActive()}`);
    console.log(`Événements actifs: ${events.length}`);
    for (const event of events) {
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 5 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      const nowTime = now.getTime();
      console.log(`--- Événement: ${event.theme} ---`);
      console.log(`ID: ${event.id}`);
      console.log(`Heure événement: ${new Date(eventTime).toLocaleString()}`);
      console.log(`Fenêtre lobby: ${new Date(lobbyTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}`);
      console.log(`Lobby ouvert: ${event.lobbyOpen}`);
      console.log(`Dans fenêtre: ${nowTime >= lobbyTime && nowTime <= endTime}`);
    }
  }

  private async emergencyLobbyCheck() {
    try {
      console.log("🚨 VÉRIFICATION D'URGENCE DES LOBBIES");
      if (this.currentLobby || this.isGlobalQuizActive()) return;

      const eventsInWindow = await this.eventService.getEventsInLobbyWindow();
      if (eventsInWindow.length > 0) {
        console.log(`⚠️ ALERTE: ${eventsInWindow.length} événement(s) dans la fenêtre de lobby mais aucun lobby ouvert!`);
        for (const event of eventsInWindow) {
          const now = Date.now();
          const eventTime = new Date(event.startDate).getTime();
          const timeUntilEvent = Math.round((eventTime - now) / 1000);
          console.log(`🔧 CORRECTION: Ouverture forcée du lobby pour "${event.theme}" (dans ${timeUntilEvent}s)`);
          await this.openEventLobby(event);
          this.server.emit('emergencyLobbyOpened', {
            event: this.formatEvent(event),
            message: 'Lobby ouvert automatiquement - événement imminent!',
          });
          break;
        }
      }
    } catch (error) {
      console.error("❌ Erreur lors de la vérification d'urgence:", error);
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
}