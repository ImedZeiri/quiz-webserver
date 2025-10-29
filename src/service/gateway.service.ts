import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { QuestionService } from './question.service';
import { EventService } from './event.service';
import { Question } from '../model/question.entity';
import { Event } from '../model/event.entity';
import type {
  QuizSession,
  GlobalQuiz,
  EventLobby,
  QuizParticipant,
  StartQuizPayload,
  SubmitAnswerPayload,
  PlayerStats
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
export class GatewayService {
  private quizSessions = new Map<string, QuizSession>();
  private globalQuiz: GlobalQuiz | null = null;
  private eventCheckInterval?: NodeJS.Timeout;
  private server: Server;
  private currentLobby: EventLobby | null = null;
  private nextEventTimer?: NodeJS.Timeout;
  private userSessions = new Map<string, UserSession>();

  constructor(
    private readonly questionService: QuestionService,
    private readonly eventService: EventService,
  ) {
    this.initializeNextEvent();
    this.startEventScheduler();
    // Vérification immédiate des événements au démarrage
    setTimeout(() => this.checkPendingEvents(), 2000);
    // Vérification périodique pour debug
    setInterval(() => this.debugEventStatus(), 30000);
  }

  setServer(server: Server) {
    this.server = server;
  }

  async getQuestionsByTheme(
    theme?: string,
    limit: number = 10,
  ): Promise<Question[]> {
    console.log(`getQuestionsByTheme - Thème: ${theme}, Limite: ${limit}`);
    
    if (theme && theme.trim() !== '') {
      const themeQuestions = await this.questionService.findByTheme(theme);
      console.log(`Questions trouvées pour le thème '${theme}': ${themeQuestions.length}`);
      
      if (themeQuestions.length > 0) {
        const result = themeQuestions.slice(0, limit);
        console.log(`Questions retournées après slice: ${result.length}`);
        return result;
      }
    }
    
    console.log(`Retour de questions aléatoires avec limite: ${limit}`);
    const randomQuestions = await this.questionService.findRandomQuestions(limit);
    console.log(`Questions aléatoires récupérées: ${randomQuestions.length}`);
    return randomQuestions;
  }

  handleConnection(clientId: string) {
    console.log(`Client connected: ${clientId}`);
    
    this.userSessions.set(clientId, {
      socketId: clientId,
      token: '',
      isConnected: true,
      isParticipating: false,
      isAuthenticated: false,
      userType: 'guest',
      connectedAt: new Date()
    });
    
    this.sendNextEventInfo(clientId);
    
    if (!this.currentLobby) {
      this.checkPendingEvents();
    }
    
    if (this.currentLobby) {
      this.sendLobbyInfo(clientId);
      this.sendEventCountdown(clientId);
    }
    this.broadcastPlayerStats();
    this.broadcastUserStats();
  }

  handleDisconnection(clientId: string) {
    console.log(`Client disconnected: ${clientId}`);
    
    this.userSessions.delete(clientId);
    
    const session = this.quizSessions.get(clientId);
    if (session?.timer) clearTimeout(session.timer);
    if (session?.timerInterval) clearInterval(session.timerInterval);
    this.quizSessions.delete(clientId);
    if (this.globalQuiz?.participants) {
      this.globalQuiz.participants.delete(clientId);
    }
    
    if (this.currentLobby?.participants.has(clientId)) {
      this.currentLobby.participants.delete(clientId);
      console.log(`Joueur ${clientId} retiré du lobby. Total: ${this.currentLobby.participants.size}`);
      this.broadcastLobbyUpdate();
    }
    this.broadcastPlayerStats();
    this.broadcastUserStats();
  }

  async startQuiz(
    clientId: string,
    payload: StartQuizPayload,
  ) {
    try {
      const { theme, limit = 10, timeLimit = 30 } = payload || {};
      const client = this.server.sockets.sockets.get(clientId);

    if (this.globalQuiz?.isActive) {
      const session: QuizSession = {
        questions: this.globalQuiz.questions,
        currentIndex: this.globalQuiz.currentQuestionIndex,
        score: 0,
        answers: [],
        isWatching: true,
        timeLimit: this.globalQuiz.timeLimit,
        timeLeft: this.globalQuiz.timeLeft,
        joinedAt: this.globalQuiz.currentQuestionIndex,
      };

      this.quizSessions.set(clientId, session);
      if (this.globalQuiz.participants) {
        this.globalQuiz.participants.set(clientId, {
          clientId,
          score: 0,
        } as QuizParticipant);
      }
      this.updateUserParticipation(clientId, true, 'watch');
      this.sendCurrentQuestion(client!, session);
      this.broadcastPlayerStats();
      return;
    }

    const questions = await this.getQuestionsByTheme(theme, limit);

    if (questions.length === 0) {
      client?.emit('error', {
        message: 'Aucune question trouvée pour ce thème',
      });
      return;
    }

    this.globalQuiz = {
      isActive: true,
      currentQuestionIndex: 0,
      questions,
      timeLimit,
      timeLeft: timeLimit,
      participants: new Map(),
    };

    this.globalQuiz.participants.set(clientId, {
      clientId,
      score: 0,
    } as QuizParticipant);

    const session: QuizSession = {
      questions,
      currentIndex: 0,
      score: 0,
      answers: [],
      isWatching: false,
      timeLimit,
      timeLeft: timeLimit,
      joinedAt: 0,
    };

    this.quizSessions.set(clientId, session);
    this.updateUserParticipation(clientId, true, 'play');
    this.startGlobalQuiz();
    } catch (error) {
      console.error('Erreur lors du démarrage du quiz:', error);
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', {
        message: 'Erreur lors du démarrage du quiz. Veuillez réessayer.',
      });
    }
  }

  submitAnswer(
    clientId: string,
    payload: SubmitAnswerPayload,
  ) {
    const session = this.quizSessions.get(clientId);
    const client = this.server.sockets.sockets.get(clientId);

    if (!session) {
      client?.emit('error', { message: 'Aucune session de quiz active' });
      return;
    }

    if (session.isWatching) {
      client?.emit('error', {
        message: 'Vous êtes en mode surveillance - réponses bloquées',
      });
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

    session.pendingAnswer = {
      questionId: payload.questionId,
      answer: payload.answer,
    };

    client?.emit('answerQueued', {
      questionId: payload.questionId,
      answer: payload.answer,
      timeLeft: session.timeLeft,
    });

    this.broadcastPlayerStats();
  }

  private startGlobalQuiz() {
    if (!this.globalQuiz) return;

    // Attendre un peu pour que les clients reçoivent l'événement autoStartQuiz
    setTimeout(() => {
      this.broadcastCurrentQuestion();

      this.globalQuiz!.timerInterval = setInterval(() => {
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

      this.globalQuiz!.timer = setTimeout(() => {
        this.handleGlobalTimeExpired();
      }, this.globalQuiz!.timeLimit * 1000);
    }, 1000);
  }

  private broadcastCurrentQuestion() {
    if (!this.globalQuiz) return;

    this.quizSessions.forEach((session, clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        session.currentIndex = this.globalQuiz!.currentQuestionIndex;
        session.timeLeft = this.globalQuiz!.timeLeft;
        session.pendingAnswer = undefined;

        this.sendCurrentQuestion(client, session);
      }
    });
  }

  private sendCurrentQuestion(client: Socket, session: QuizSession) {
    const currentQuestion = session.questions[session.currentIndex];

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
      previousAnswer:
        session.answers.length > 0
          ? session.answers[session.answers.length - 1]
          : null,
      isWatching: session.isWatching,
      timeLeft: session.timeLeft,
      ...this.getPlayerStats(),
    });
  }

  private handleGlobalTimeExpired() {
    if (!this.globalQuiz) return;

    if (this.globalQuiz.timerInterval)
      clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

    this.quizSessions.forEach((session, clientId) => {
      if (session.currentIndex === this.globalQuiz!.currentQuestionIndex) {
        const currentQuestion = session.questions[session.currentIndex];

        let userAnswer = 0;
        let isCorrect = false;

        if (
          !session.isWatching &&
          session.pendingAnswer &&
          session.pendingAnswer.questionId === currentQuestion.id
        ) {
          userAnswer = session.pendingAnswer.answer;
          isCorrect = currentQuestion.correctResponse === userAnswer;
          if (isCorrect) {
            session.score++;
            const participant = this.globalQuiz!.participants?.get(clientId);
            if (participant) {
              participant.score = session.score;
              if (
                this.globalQuiz!.currentQuestionIndex ===
                this.globalQuiz!.questions.length - 1
              ) {
                participant.finishedAt = new Date();
              }
            }
          } else {
            session.isWatching = true;
          }
        } else if (!session.isWatching) {
          session.isWatching = true;
        }

        session.answers.push({
          questionId: currentQuestion.id,
          userAnswer,
          correct: isCorrect,
        });

        session.pendingAnswer = undefined;
      }
    });

    this.globalQuiz.currentQuestionIndex++;

    if (
      this.globalQuiz.currentQuestionIndex >= this.globalQuiz.questions.length
    ) {
      this.completeGlobalQuiz();
    } else {
      this.globalQuiz.timeLeft = this.globalQuiz.timeLimit;
      this.startGlobalQuiz();
    }
  }

  private async completeGlobalQuiz() {
    if (!this.globalQuiz) return;

    if (this.globalQuiz.timerInterval)
      clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);

    let winner: string | null = null;
    if (this.globalQuiz.event && this.globalQuiz.participants.size > 0) {
      const participants = Array.from(this.globalQuiz.participants.values())
        .filter((p: QuizParticipant) => p.finishedAt)
        .sort((a: QuizParticipant, b: QuizParticipant) => {
          if (a.score !== b.score) return b.score - a.score;
          return a.finishedAt!.getTime() - b.finishedAt!.getTime();
        });

      if (participants.length > 0) {
        winner = participants[0].clientId;
        await this.eventService.completeEvent(this.globalQuiz.event.id, winner!);
      }

      this.server.emit('eventCompleted', {
        eventId: this.globalQuiz.event.id,
        winner,
      });
    }

    this.quizSessions.forEach((session, clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        client.emit('quizCompleted', {
          score: session.score,
          totalQuestions: session.questions.length,
          answers: session.answers,
          joinedAt: session.joinedAt,
          winner,
          isWinner: clientId === winner,
        });
      }
    });

    setTimeout(() => {
      this.server.disconnectSockets(true);
    }, 5000);

    this.globalQuiz = null;
    this.quizSessions.clear();
  }

  private getPlayerStats(): PlayerStats {
    const activePlayers = Array.from(this.quizSessions.values()).filter(
      (s) => !s.isWatching,
    ).length;
    const watchingPlayers = Array.from(this.quizSessions.values()).filter(
      (s) => s.isWatching,
    ).length;

    return {
      activePlayers,
      watchingPlayers,
      totalPlayers: activePlayers + watchingPlayers,
    };
  }

  private broadcastPlayerStats() {
    this.server.emit('playerStats', this.getPlayerStats());
  }

  authenticateUser(clientId: string, token: string) {
    const userSession = this.userSessions.get(clientId);
    if (userSession) {
      userSession.token = token;
      userSession.userId = this.extractUserIdFromToken(token);
      userSession.isAuthenticated = true;
      userSession.userType = 'authenticated';
      
      console.log('========================================');
      console.log('🔗 FUSION TOKEN/SESSION');
      console.log('========================================');
      console.log(`🆔 Socket ID: ${clientId}`);
      console.log(`🔑 Token: ${token}`);
      console.log(`👤 User ID: ${userSession.userId || 'N/A'}`);
      console.log(`🔐 Type: ${userSession.userType}`);
      console.log(`⏰ Connecté à: ${userSession.connectedAt.toLocaleString()}`);
      console.log('========================================\n');
      
      this.broadcastUserStats();
    }
  }

  private extractUserIdFromToken(token: string): string | undefined {
    try {
      const cleanToken = token.replace('Bearer ', '');
      const payload = JSON.parse(atob(cleanToken.split('.')[1]));
      return payload.sub || payload.userId || payload.id;
    } catch (error) {
      console.warn('Impossible d\'extraire l\'ID utilisateur du token');
      return undefined;
    }
  }

  private updateUserParticipation(clientId: string, isParticipating: boolean, mode?: 'play' | 'watch') {
    const userSession = this.userSessions.get(clientId);
    if (userSession) {
      userSession.isParticipating = isParticipating;
      userSession.participationMode = mode;
      this.broadcastUserStats();
    }
  }

  private getUserStats() {
    const sessions = Array.from(this.userSessions.values());
    
    const connectedUsers = sessions.filter(s => s.isConnected).length;
    const authenticatedUsers = sessions.filter(s => s.isAuthenticated).length;
    const guestUsers = sessions.filter(s => !s.isAuthenticated).length;
    const participatingUsers = sessions.filter(s => s.isParticipating).length;
    const playingUsers = sessions.filter(s => s.participationMode === 'play').length;
    const watchingUsers = sessions.filter(s => s.participationMode === 'watch').length;
    
    // Stats par type d'utilisateur
    const authenticatedPlaying = sessions.filter(s => s.isAuthenticated && s.participationMode === 'play').length;
    const guestPlaying = sessions.filter(s => !s.isAuthenticated && s.participationMode === 'play').length;
    const authenticatedWatching = sessions.filter(s => s.isAuthenticated && s.participationMode === 'watch').length;
    const guestWatching = sessions.filter(s => !s.isAuthenticated && s.participationMode === 'watch').length;
    
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
      totalSessions: sessions.length
    };
  }

  private broadcastUserStats() {
    const stats = this.getUserStats();
    console.log('📊 STATS UTILISATEURS:', stats);
    this.server.emit('userStats', stats);
  }

  private async initializeNextEvent() {
    const nextEvent = await this.eventService.getNextEvent();
    if (nextEvent) {
      this.scheduleEventCountdown(nextEvent);
    }
  }

  private scheduleEventCountdown(event: Event) {
    const now = new Date().getTime();
    const eventTime = new Date(event.startDate).getTime();
    const lobbyTime = eventTime - 5 * 60 * 1000;
    const startTime = eventTime;
    const endTime = eventTime + 2 * 60 * 1000;

    console.log(`Planification événement: ${event.theme}`);
    console.log(`Heure actuelle: ${new Date(now).toLocaleString()}`);
    console.log(`Heure événement: ${new Date(eventTime).toLocaleString()}`);
    console.log(`Heure lobby: ${new Date(lobbyTime).toLocaleString()}`);
    console.log(`Heure démarrage: ${new Date(startTime).toLocaleString()}`);
    console.log(`Lobby dans: ${Math.max(0, lobbyTime - now) / 1000}s`);
    console.log(`Début dans: ${Math.max(0, startTime - now) / 1000}s`);

    // Si c'est déjà l'heure d'ouvrir le lobby
    if (now >= lobbyTime && !event.lobbyOpen && now <= endTime) {
      console.log('Ouverture immédiate du lobby');
      this.openEventLobby(event);
    } else if (lobbyTime > now) {
      // Programmer l'ouverture du lobby
      const delay = lobbyTime - now;
      console.log(`Programmation ouverture lobby dans ${delay / 1000}s`);
      this.nextEventTimer = setTimeout(() => {
        this.checkPendingEvents(); // Utiliser checkPendingEvents au lieu d'appeler directement openEventLobby
      }, delay);
    }

    this.broadcastNextEvent(event);
  }

  private startEventScheduler() {
    setInterval(async () => {
      if (this.currentLobby) return;
      
      const eventsReady = await this.eventService.getEventsReadyForLobby();
      
      for (const event of eventsReady) {
        const now = new Date().getTime();
        const eventTime = new Date(event.startDate).getTime();
        const lobbyTime = eventTime - 5 * 60 * 1000;
        const endTime = eventTime + 2 * 60 * 1000;
        
        // Ouvrir le lobby si on est dans la fenêtre de 5 min avant à 2 min après l'événement
        if (now >= lobbyTime && now <= endTime && !event.lobbyOpen) {
          console.log(`Ouverture automatique du lobby pour: ${event.theme}`);
          console.log(`Heure actuelle: ${new Date(now).toLocaleString()}`);
          console.log(`Heure événement: ${new Date(eventTime).toLocaleString()}`);
          console.log(`Heure lobby: ${new Date(lobbyTime).toLocaleString()}`);
          console.log(`Fenêtre lobby: ${new Date(lobbyTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}`);
          this.openEventLobby(event);
          break; // Traiter un seul événement à la fois
        }
      }
    }, 5000); // Vérifier toutes les 5 secondes pour plus de réactivité
  }

  private async openEventLobby(event: Event) {
    if (this.currentLobby) return;
    
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
  }

  private startEventCountdown() {
    if (!this.currentLobby) return;

    const updateCountdown = () => {
      if (!this.currentLobby) return;

      const now = new Date().getTime();
      const eventTime = new Date(this.currentLobby.event.startDate).getTime();
      const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));

      this.server.emit('eventCountdown', {
        timeLeft,
        participants: this.currentLobby.participants.size,
        minPlayers: this.currentLobby.event.minPlayers,
      });

      if (timeLeft <= 0) {
        this.startEventIfReady();
      }
    };

    updateCountdown();
    this.currentLobby.countdownTimer = setInterval(updateCountdown, 1000);
  }

  private async startEventIfReady() {
    if (!this.currentLobby) return;

    if (this.currentLobby.countdownTimer) {
      clearInterval(this.currentLobby.countdownTimer);
    }

    console.log(
      `Vérification finale des participants: ${this.currentLobby.participants.size}`,
    );
    console.log('Participants:', Array.from(this.currentLobby.participants));

    if (this.currentLobby.participants.size > 0) {
      console.log("Démarrage de l'événement avec les joueurs présents");
      const lobbyParticipants = new Set(this.currentLobby.participants);
      await this.startEventQuiz(this.currentLobby.event, lobbyParticipants as Set<string>);
    } else {
      console.log('Événement annulé - aucun joueur');
      this.server.emit('eventCancelled', {
        reason: 'Aucun joueur présent',
        required: this.currentLobby.event.minPlayers,
        actual: this.currentLobby.participants.size,
      });
    }

    this.currentLobby = null;
    this.initializeNextEvent();
  }

  private async startEventQuiz(event: Event, participants: Set<string>) {
    console.log(`=== DÉMARRAGE QUIZ ÉVÉNEMENT ===`);
    console.log(`Thème: ${event.theme}`);
    console.log(`Nombre de questions demandées: ${event.numberOfQuestions}`);
    
    const questions = await this.getQuestionsByTheme(
      event.theme,
      event.numberOfQuestions,
    );
    
    console.log(`Nombre de questions récupérées: ${questions.length}`);
    console.log(`Questions:`, questions.map(q => ({ id: q.id, theme: q.theme, text: q.questionText.substring(0, 50) + '...' })));

    this.globalQuiz = {
      isActive: true,
      currentQuestionIndex: 0,
      questions,
      timeLimit: 30,
      timeLeft: 30,
      event,
      participants: new Map(),
    };

    participants.forEach((clientId) => {
      this.globalQuiz!.participants.set(clientId, {
        clientId,
        score: 0,
      } as QuizParticipant);

      const session: QuizSession = {
        questions,
        currentIndex: 0,
        score: 0,
        answers: [],
        isWatching: false,
        timeLimit: 30,
        timeLeft: 30,
        joinedAt: 0,
      };
      this.quizSessions.set(clientId, session);
      this.updateUserParticipation(clientId, true, 'play');
    });

    console.log(`Quiz démarré avec ${participants.size} participants et ${questions.length} questions`);
    console.log(`=== FIN DÉMARRAGE QUIZ ÉVÉNEMENT ===`);
    console.log(`Quiz démarré avec ${participants.size} participants`);

    this.server.emit('eventStarted', {
      event: {
        id: event.id,
        theme: event.theme,
        numberOfQuestions: event.numberOfQuestions,
      },
    });

    // Démarrer automatiquement le quiz pour tous les participants
    participants.forEach((clientId) => {
      const client = this.server.sockets.sockets.get(clientId);
      if (client) {
        client.emit('autoStartQuiz', {
          theme: event.theme,
          limit: event.numberOfQuestions,
          timeLimit: 30,
        });
      }
    });

    this.startGlobalQuiz();
  }

  joinLobby(clientId: string) {
    if (!this.currentLobby) {
      const client = this.server.sockets.sockets.get(clientId);
      client?.emit('error', { message: 'Aucun lobby ouvert actuellement' });
      return;
    }

    const wasAlreadyInLobby = this.currentLobby.participants.has(clientId);
    this.currentLobby.participants.add(clientId);
    console.log(
      `Joueur ${clientId} ${wasAlreadyInLobby ? 'déjà dans' : 'a rejoint'} le lobby. Total: ${this.currentLobby.participants.size}`,
    );
    this.broadcastLobbyUpdate();

    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('lobbyJoined', {
      event: this.currentLobby.event,
      participants: this.currentLobby.participants.size,
    });
  }

  private broadcastLobbyUpdate() {
    if (!this.currentLobby) return;

    console.log(
      `Mise à jour lobby: ${this.currentLobby.participants.size}/${this.currentLobby.event.minPlayers} participants`,
    );
    this.server.emit('lobbyUpdate', {
      participants: this.currentLobby.participants.size,
      minPlayers: this.currentLobby.event.minPlayers,
    });
  }

  private broadcastNextEvent(event: Event) {
    this.server.emit('nextEvent', {
      id: event.id,
      theme: event.theme,
      startDate: event.startDate,
      numberOfQuestions: event.numberOfQuestions,
    });
  }

  private sendNextEventInfo(clientId: string) {
    this.eventService.getNextEvent().then((event) => {
      if (event) {
        const client = this.server.sockets.sockets.get(clientId);
        client?.emit('nextEvent', {
          id: event.id,
          theme: event.theme,
          startDate: event.startDate,
          numberOfQuestions: event.numberOfQuestions,
        });
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

    const now = new Date().getTime();
    const eventTime = new Date(this.currentLobby.event.startDate).getTime();
    const timeLeft = Math.max(0, Math.floor((eventTime - now) / 1000));

    const client = this.server.sockets.sockets.get(clientId);
    client?.emit('eventCountdown', {
      timeLeft,
      participants: this.currentLobby.participants.size,
      minPlayers: this.currentLobby.event.minPlayers,
    });
  }

  private async checkPendingEvents() {
    console.log('=== VÉRIFICATION ÉVÉNEMENTS ===');
    
    if (this.currentLobby) {
      console.log('Un lobby est déjà ouvert');
      return;
    }
    
    const eventsReady = await this.eventService.getEventsReadyForLobby();
    console.log(`Événements prêts: ${eventsReady.length}`);
    
    for (const event of eventsReady) {
      const now = new Date().getTime();
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 5 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      
      console.log(`\n--- Événement ID: ${event.id} ---`);
      console.log(`Thème: "${event.theme}" (vide: ${!event.theme || event.theme.trim() === ''})`);
      console.log(`Maintenant: ${new Date(now).toISOString()}`);
      console.log(`Lobby ouvre à: ${new Date(lobbyTime).toISOString()}`);
      console.log(`Événement à: ${new Date(eventTime).toISOString()}`);
      console.log(`Lobby ferme à: ${new Date(endTime).toISOString()}`);
      console.log(`Dans fenêtre: ${now >= lobbyTime && now <= endTime}`);
      console.log(`LobbyOpen en DB: ${event.lobbyOpen}`);
      
      if (now >= lobbyTime && now <= endTime) {
        console.log(`\n🚀 OUVERTURE DU LOBBY`);
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
        
        console.log(`Lobby ouvert avec succès!`);
        break;
      }
    }
    console.log('=== FIN VÉRIFICATION ===\n');
  }

  private async debugEventStatus() {
    const now = new Date();
    const events = await this.eventService.findActiveEvents();
    
    console.log('=== DEBUG STATUS ===');
    console.log(`Heure actuelle: ${now.toLocaleString()}`);
    console.log(`Lobby actuel: ${this.currentLobby ? 'OUVERT' : 'FERMÉ'}`);
    console.log(`Événements actifs: ${events.length}`);
    
    for (const event of events) {
      const eventTime = new Date(event.startDate).getTime();
      const lobbyTime = eventTime - 5 * 60 * 1000;
      const endTime = eventTime + 2 * 60 * 1000;
      const nowTime = now.getTime();
      
      console.log(`\n--- Événement: ${event.theme} ---`);
      console.log(`ID: ${event.id}`);
      console.log(`Heure événement: ${new Date(eventTime).toLocaleString()}`);
      console.log(`Fenêtre lobby: ${new Date(lobbyTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}`);
      console.log(`Lobby ouvert: ${event.lobbyOpen}`);
      console.log(`Dans fenêtre: ${nowTime >= lobbyTime && nowTime <= endTime}`);
      console.log(`Temps jusqu'au lobby: ${Math.round((lobbyTime - nowTime) / 1000)}s`);
    }
    console.log('===================\n');
  }
}