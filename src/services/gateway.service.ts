import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { QuestionService } from './question.service';
import { EventService } from './event.service';
import { Question } from '../entities/question.entity';
import { Event } from '../entities/event.entity';

export interface QuizSession {
  questions: Question[];
  currentIndex: number;
  score: number;
  answers: { questionId: number; userAnswer: number; correct: boolean }[];
  isWatching: boolean;
  timer?: NodeJS.Timeout;
  timerInterval?: NodeJS.Timeout;
  timeLimit: number;
  timeLeft: number;
  pendingAnswer?: { questionId: number; answer: number };
  joinedAt: number;
}

export interface GlobalQuiz {
  isActive: boolean;
  currentQuestionIndex: number;
  questions: Question[];
  timeLimit: number;
  timeLeft: number;
  timer?: NodeJS.Timeout;
  timerInterval?: NodeJS.Timeout;
  event?: Event;
  participants: Map<string, { clientId: string; score: number; finishedAt?: Date }>;
}

@Injectable()
export class GatewayService {
  private quizSessions = new Map<string, QuizSession>();
  private globalQuiz: GlobalQuiz | null = null;
  private eventCheckInterval?: NodeJS.Timeout;
  private server: Server;

  constructor(
    private readonly questionService: QuestionService,
    private readonly eventService: EventService
  ) {
    this.startEventChecker();
  }

  setServer(server: Server) {
    this.server = server;
  }

  async getQuestionsByTheme(theme?: string, limit: number = 10): Promise<Question[]> {
    if (theme) {
      const themeQuestions = await this.questionService.findByTheme(theme);
      return themeQuestions.slice(0, limit);
    }
    return this.questionService.findRandomQuestions(limit);
  }

  handleConnection(clientId: string) {
    console.log(`Client connected: ${clientId}`);
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
    this.broadcastPlayerStats();
  }

  async startQuiz(clientId: string, payload: { theme?: string; limit?: number; timeLimit?: number }) {
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
        joinedAt: this.globalQuiz.currentQuestionIndex
      };
      
      this.quizSessions.set(clientId, session);
      if (this.globalQuiz.participants) {
        this.globalQuiz.participants.set(clientId, {
          clientId,
          score: 0
        });
      }
      this.sendCurrentQuestion(client!, session);
      this.broadcastPlayerStats();
      return;
    }
    
    const questions = await this.getQuestionsByTheme(theme, limit);
    
    if (questions.length === 0) {
      client?.emit('error', { message: 'Aucune question trouvée pour ce thème' });
      return;
    }

    this.globalQuiz = {
      isActive: true,
      currentQuestionIndex: 0,
      questions,
      timeLimit,
      timeLeft: timeLimit,
      participants: new Map()
    };
    
    this.globalQuiz.participants.set(clientId, {
      clientId,
      score: 0
    });

    const session: QuizSession = {
      questions,
      currentIndex: 0,
      score: 0,
      answers: [],
      isWatching: false,
      timeLimit,
      timeLeft: timeLimit,
      joinedAt: 0
    };
    
    this.quizSessions.set(clientId, session);
    this.startGlobalQuiz();
  }

  submitAnswer(clientId: string, payload: { questionId: number; answer: number }) {
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

    session.pendingAnswer = {
      questionId: payload.questionId,
      answer: payload.answer
    };

    client?.emit('answerQueued', {
      questionId: payload.questionId,
      answer: payload.answer,
      timeLeft: session.timeLeft
    });
    
    this.broadcastPlayerStats();
  }

  private startGlobalQuiz() {
    if (!this.globalQuiz) return;
    
    this.broadcastCurrentQuestion();
    
    this.globalQuiz.timerInterval = setInterval(() => {
      if (!this.globalQuiz) return;
      
      this.globalQuiz.timeLeft--;
      this.server.emit('timerUpdate', { 
        timeLeft: this.globalQuiz.timeLeft,
        ...this.getPlayerStats()
      });
      
      if (this.globalQuiz.timeLeft <= 0) {
        this.handleGlobalTimeExpired();
      }
    }, 1000);

    this.globalQuiz.timer = setTimeout(() => {
      this.handleGlobalTimeExpired();
    }, this.globalQuiz.timeLimit * 1000);
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
        response4: currentQuestion.response4
      },
      questionNumber: session.currentIndex + 1,
      totalQuestions: session.questions.length,
      previousAnswer: session.answers.length > 0 ? session.answers[session.answers.length - 1] : null,
      isWatching: session.isWatching,
      timeLeft: session.timeLeft,
      ...this.getPlayerStats()
    });
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
          }
        } else if (!session.isWatching) {
          session.isWatching = true;
        }
        
        session.answers.push({
          questionId: currentQuestion.id,
          userAnswer,
          correct: isCorrect
        });
        
        session.pendingAnswer = undefined;
      }
    });

    this.globalQuiz.currentQuestionIndex++;
    
    if (this.globalQuiz.currentQuestionIndex >= this.globalQuiz.questions.length) {
      this.completeGlobalQuiz();
    } else {
      this.globalQuiz.timeLeft = this.globalQuiz.timeLimit;
      this.startGlobalQuiz();
    }
  }

  private async completeGlobalQuiz() {
    if (!this.globalQuiz) return;
    
    if (this.globalQuiz.timerInterval) clearInterval(this.globalQuiz.timerInterval);
    if (this.globalQuiz.timer) clearTimeout(this.globalQuiz.timer);
    
    let winner: string | null = null;
    if (this.globalQuiz.event && this.globalQuiz.participants.size > 0) {
      const participants = Array.from(this.globalQuiz.participants.values())
        .filter(p => p.finishedAt)
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return a.finishedAt!.getTime() - b.finishedAt!.getTime();
        });
      
      if (participants.length > 0) {
        winner = participants[0].clientId;
        await this.eventService.completeEvent(this.globalQuiz.event.id, winner);
      }
      
      this.server.emit('eventCompleted', {
        eventId: this.globalQuiz.event.id,
        winner
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
          isWinner: clientId === winner
        });
      }
    });
    
    setTimeout(() => {
      this.server.disconnectSockets(true);
    }, 5000);
    
    this.globalQuiz = null;
    this.quizSessions.clear();
  }

  private getPlayerStats() {
    const activePlayers = Array.from(this.quizSessions.values()).filter(s => !s.isWatching).length;
    const watchingPlayers = Array.from(this.quizSessions.values()).filter(s => s.isWatching).length;
    
    return {
      activePlayers,
      watchingPlayers,
      totalPlayers: activePlayers + watchingPlayers
    };
  }

  private broadcastPlayerStats() {
    this.server.emit('playerStats', this.getPlayerStats());
  }

  private startEventChecker() {
    this.eventCheckInterval = setInterval(async () => {
      if (this.globalQuiz?.isActive) return;
      
      const activeEvents = await this.eventService.findActiveEvents();
      const now = new Date();
      
      for (const event of activeEvents) {
        if (event.startDate <= now) {
          await this.startEventQuiz(event);
          break;
        }
      }
    }, 5000);
  }

  private async startEventQuiz(event: Event) {
    const questions = await this.getQuestionsByTheme(event.theme, event.numberOfQuestions);
    
    this.globalQuiz = {
      isActive: true,
      currentQuestionIndex: 0,
      questions,
      timeLimit: 30,
      timeLeft: 30,
      event,
      participants: new Map()
    };
    
    this.server.emit('eventStarted', {
      event: {
        id: event.id,
        theme: event.theme,
        numberOfQuestions: event.numberOfQuestions
      }
    });
    
    this.startGlobalQuiz();
  }
}