import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { QuestionService } from './question.service';
import { EventService } from './event.service';

import type {
  QuizSession,
  GlobalQuiz,
  EventLobby,
  QuizParticipant,
  StartQuizPayload,
  SubmitAnswerPayload,
  PlayerStats,
} from '../types';
import { Question } from 'src/entities/question.entity';

@Injectable()
export class GatewayService {
  private quizSessions = new Map<string, QuizSession>();
  private globalQuiz: GlobalQuiz | null = null;
  private eventCheckInterval?: NodeJS.Timeout;
  private server: Server;
  private currentLobby: EventLobby | null = null;
  private nextEventTimer?: NodeJS.Timeout;

  constructor(
    private readonly questionService: QuestionService,
    private readonly eventService: EventService,
  ) {
    this.initializeNextEvent();
  }

  setServer(server: Server) {
    this.server = server;
  }

  async getQuestionsByTheme(
    theme?: string,
    limit: number = 10,
  ): Promise<Question[]> {
    if (theme) {
      const themeQuestions = await this.questionService.findByTheme(theme);
      return themeQuestions.slice(0, limit);
    }
    return this.questionService.findRandomQuestions(limit);
  }

  handleConnection(clientId: string) {
    console.log(`Client connected: ${clientId}`);
    this.sendNextEventInfo(clientId);
    if (this.currentLobby) {
      this.sendLobbyInfo(clientId);
    }
    this.broadcastPlayerStats();
  }

  handleDisconnection(clientId: string) {
    console.log(`Client disconnected: ${clientId}`);
    const session = this.quizSessions.get(clientId);
    if (session?.timer) clearTimeout(session.timer);
    if (session?.timerInterval) clearInterval(session.timerInterval);
    this.quizSessions.delete(clientId);
    if (this.globalQuiz?.participants) {
      this.globalQuiz.participants.delete(clientId);
    }
    // Ne pas supprimer du lobby lors de la déconnexion
    this.broadcastPlayerStats();
  }

  async startQuiz(clientId: string, payload: StartQuizPayload) {
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
    this.startGlobalQuiz();
  }

  submitAnswer(clientId: string, payload: SubmitAnswerPayload) {
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
        await this.eventService.completeEvent(
          this.globalQuiz.event.id,
          winner!,
        );
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

    if (lobbyTime > now) {
      this.nextEventTimer = setTimeout(() => {
        this.openEventLobby(event);
      }, lobbyTime - now);
    } else if (eventTime > now) {
      this.openEventLobby(event);
    }

    this.broadcastNextEvent(event);
  }

  private async openEventLobby(event: Event) {
    await this.eventService.openLobby(event.id);

    this.currentLobby = {
      event,
      participants: new Set(),
      countdownTimer: undefined,
      lobbyTimer: undefined,
    };

    this.startEventCountdown();

    this.server.emit('lobbyOpened', {
      event: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        id: event.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        theme: event.theme,
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
      await this.startEventQuiz(
        this.currentLobby.event,
        lobbyParticipants as Set<string>,
      );
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
    const questions = await this.getQuestionsByTheme(
      event.theme,
      event.numberOfQuestions,
    );

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
    });

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
}
