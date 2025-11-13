export interface StartQuizPayload {
  theme?: string;
  limit?: number;
  timeLimit?: number;
}

export interface SubmitAnswerPayload {
  questionId: number;
  answer: number;
}

export interface PlayerStats {
  activePlayers: number;
  watchingPlayers: number;
  totalPlayers: number;
}

export interface QuizQuestionResponse {
  question: {
    id: number;
    theme: string;
    questionText: string;
    response1: string;
    response2: string;
    response3: string;
    response4: string;
  };
  questionNumber: number;
  totalQuestions: number;
  previousAnswer: any;
  isWatching: boolean;
  timeLeft: number;
}

export interface QuizCompletedResponse {
  score: number;
  totalQuestions: number;
  answers: any[];
  joinedAt: number;
  winner?: string;
  isWinner: boolean;
}

export interface EventCompletedResponse {
  eventId: string;
  winner?: string;
  winnerPhone?: string;
  winnerDisplay?: string;
}

export interface WinnerInfo {
  sessionId: string;
  username?: string;
  phoneNumber?: string;
  userId?: string;
}

export interface StartSoloQuizPayload {
  theme?: string;
}

export interface SoloQuestion {
  id: number;
  theme: string;
  questionText: string;
  response1: string;
  response2: string;
  response3: string;
  response4: string;
  correctResponse: number;
}

export interface SoloQuestionsResponse {
  questions: SoloQuestion[];
}

export interface UserSession {
  socketId: string;
  token: string;
  userId?: string;
  isConnected: boolean;
  isParticipating: boolean;
  isAuthenticated: boolean;
  userType: 'guest' | 'authenticated';
  connectedAt: Date;
  participationMode?: 'play' | 'watch';
  currentContext?: UserContext;
  lastActivity?: Date;
}

export interface UserContext {
  mode: 'home' | 'solo' | 'online' | 'quiz';
  isSolo?: boolean;
  isInLobby?: boolean;
  isInQuiz?: boolean;
  subscriptions: ContextSubscription[];
  lastUpdated?: Date;
  requiresAuth?: boolean;
}

export interface ContextSubscription {
  event: string;
  enabled: boolean;
  reason?: string; // Raison pour laquelle l'événement est activé/désactivé
}

export interface SetContextPayload {
  mode: 'home' | 'solo' | 'online' | 'quiz';
  isSolo?: boolean;
  isInLobby?: boolean;
  isInQuiz?: boolean;
}

export interface ContextSetResponse {
  mode: string;
  success: boolean;
  enabledEvents: string[];
  message?: string;
}

export interface ContextValidationError {
  message: string;
  code: 'INVALID_CONTEXT_PAYLOAD' | 'INVALID_MODE' | 'AUTH_REQUIRED_FOR_ONLINE' | 'SESSION_NOT_FOUND' | 'AUTH_REQUIRED_FOR_MULTIPLAYER';
  requiredAction?: 'LOGIN' | 'RECONNECT';
}