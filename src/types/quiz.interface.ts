import { Question } from 'src/entities/question.entity';

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

export interface QuizAnswer {
  questionId: number;
  userAnswer: number;
  correct: boolean;
}

export interface PendingAnswer {
  questionId: number;
  answer: number;
}
