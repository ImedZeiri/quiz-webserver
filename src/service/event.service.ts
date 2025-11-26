import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private eventSchedulerInterval: NodeJS.Timeout | null = null;
  private lobbySchedulerInterval: NodeJS.Timeout | null = null;
  private eventCompletionInterval: NodeJS.Timeout | null = null;
  private isDatabaseConnected = true;

  // 🔥 NEW: Event creation locking and throttling
  private eventCreationLock = false;
  private lastEventCreationTime = 0;
  private readonly MIN_EVENT_CREATION_INTERVAL = 2000; // 2 seconds between event creations
  private isSchedulerRunning = false;
  private readonly MAX_EVENTS_PER_CYCLE = 3; // Maximum events to create in one cycle

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  onModuleInit() {
    console.log('🚀 EventService initializing...');
    
    // 🔥 TEMPORARY: Start with safe mode to prevent flood
    console.log('🛑 Starting in SAFE MODE to prevent event flood');
    
    this.startEventScheduler();
    // Temporarily disable these to prevent conflicts
    // this.startLobbyScheduler();
    // this.startEventCompletionChecker();
    this.startCleanupScheduler();
    this.initializeEvents();
  }

 onModuleDestroy() {
  console.log('🛑 EventService shutting down...');
  this.emergencyStopSchedulers();
}

  // 🔥 NEW: Emergency stop method
public emergencyStopSchedulers(): void {
  console.log('🛑 EMERGENCY STOP: Stopping all event schedulers');
  
  if (this.eventSchedulerInterval) {
    clearInterval(this.eventSchedulerInterval);
    this.eventSchedulerInterval = null;
  }
  if (this.lobbySchedulerInterval) {
    clearInterval(this.lobbySchedulerInterval);
    this.lobbySchedulerInterval = null;
  }
  if (this.eventCompletionInterval) {
    clearInterval(this.eventCompletionInterval);
    this.eventCompletionInterval = null;
  }
  
 
}
  // 🔥 NEW: Safe scheduler starter
 public startSchedulersSafely(): void {

  
  this.emergencyStopSchedulers(); // Stop first
  
  // Start with longer intervals
  this.eventSchedulerInterval = setInterval(async () => {
    if (this.isDatabaseConnected) {
      await this.checkEventSchedule();
    }
  }, 2 * 60 * 1000); // 2 minutes instead of 1

  this.lobbySchedulerInterval = setInterval(async () => {
    if (this.isDatabaseConnected) {
      await this.checkAndOpenLobbies();
    }
  }, 60 * 1000); // 1 minute instead of 30 seconds

  this.eventCompletionInterval = setInterval(async () => {
    if (this.isDatabaseConnected) {
      await this.checkCompletedEventsAndCreateNew();
    }
  }, 60 * 1000); // 1 minute instead of 30 seconds

 
}

  // 🔥 NEW: Event creation locking mechanism
  private async acquireEventCreationLock(): Promise<boolean> {
    if (this.eventCreationLock) {
    
      return false;
    }
    
    const now = Date.now();
    if (now - this.lastEventCreationTime < this.MIN_EVENT_CREATION_INTERVAL) {
      console.log('🚫 Event creation throttled - too frequent');
      return false;
    }
    
    this.eventCreationLock = true;
    this.lastEventCreationTime = now;
    return true;
  }
  
  private releaseEventCreationLock(): void {
    this.eventCreationLock = false;
  }

private startEventCompletionChecker(): void {
  // Vérifier toutes les 60 secondes les événements terminés (increased from 30s)
  this.eventCompletionInterval = setInterval(async () => {
    if (this.isDatabaseConnected) {
      await this.checkCompletedEventsAndCreateNew();
    }
  }, 60 * 1000);

  // Exécuter immédiatement au démarrage
  this.checkCompletedEventsAndCreateNew();
}

  private async checkCompletedEventsAndCreateNew(): Promise<void> {
    if (!await this.acquireEventCreationLock()) {
      return;
    }

    try {
      const now = new Date();
      
      // 🔥 IMPROVED: Only process a limited number of events
      const recentlyCompletedEvents = await this.eventModel
        .find({
          isCompleted: true,
          completedAt: {
            $gte: new Date(now.getTime() - 5 * 60 * 1000), // Extended to 5 minutes
            $lte: now
          },
          nextEventCreated: { $ne: true }
        })
        .sort({ completedAt: -1 })
        .limit(3) // 🔥 LIMIT TO 3 EVENTS MAX
        .exec();

      let eventsProcessed = 0;
      for (const completedEvent of recentlyCompletedEvents) {
        if (eventsProcessed >= 2) break; // 🔥 SAFETY: Process max 2 events
        
      
        
        // Check if quiz is active
        const gatewayService = (global as any).gatewayService;
        if (gatewayService && gatewayService.isGlobalQuizActivePublic && gatewayService.isGlobalQuizActivePublic()) {
        
          continue;
        }

        const nextEventTime = new Date(completedEvent.completedAt.getTime() + 1 * 60 * 1000);
        
        if (nextEventTime.getTime() <= now.getTime()) {
          nextEventTime.setTime(now.getTime() + 1 * 60 * 1000);
        }

        const theme = `Auto Event - ${nextEventTime.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}`;

        await this.createEvent(theme, nextEventTime, 5, 2);

        await this.eventModel.findByIdAndUpdate(
          completedEvent._id,
          { nextEventCreated: true }
        ).exec();

     
        eventsProcessed++;
      }

      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error in checkCompletedEventsAndCreateNew:', error);
      this.handleDatabaseError(error);
    } finally {
      this.releaseEventCreationLock();
    }
  }

  private async initializeEvents(): Promise<void> {
    try {
      console.log('🚀 Initializing event schedule...');

      // Mettre à jour le schéma pour les événements existants
      await this.updateEventSchemaForExistingEvents();

      // Check for existing upcoming events
      const upcomingEvents = await this.eventModel
        .find({
          isCompleted: false,
          startDate: { $gt: new Date() },
        })
        .sort({ startDate: 1 })
        .exec();

      if (upcomingEvents.length === 0) {
        await this.createNextEvent();
      
      } else {
    
        // Don't fill schedule on startup to prevent flood
      }
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error initializing events:', error);
      this.isDatabaseConnected = false;
      setTimeout(() => this.initializeEvents(), 10000);
    }
  }

  private startEventScheduler(): void {
  // Check every 2 minutes for event scheduling needs (increased from 1 minute)
  this.eventSchedulerInterval = setInterval(async () => {
    if (this.isDatabaseConnected) {
      await this.checkEventSchedule();
    }
  }, 2 * 60 * 1000);

  // Run immediately on startup
  this.checkEventSchedule();
}


private startLobbyScheduler(): void {
  // Check every 60 seconds for lobbies that need to be opened (increased from 30 seconds)
  this.lobbySchedulerInterval = setInterval(async () => {
    if (this.isDatabaseConnected) {
      await this.checkAndOpenLobbies();
    }
  }, 60 * 1000);

  // Run immediately on startup
  this.checkAndOpenLobbies();
}

  private async checkEventSchedule(): Promise<void> {
    if (this.isSchedulerRunning) {
      console.log('🚫 Event scheduler already running - skipping');
      return;
    }

    if (!await this.acquireEventCreationLock()) {
      return;
    }

    try {
      this.isSchedulerRunning = true;
      
      const now = new Date();
      
      // Check if a quiz is active via gateway service
      const gatewayService = (global as any).gatewayService;
      if (gatewayService && gatewayService.isGlobalQuizActivePublic && gatewayService.isGlobalQuizActivePublic()) {
        console.log('🚫 Quiz in progress - postponing event creation');
        return;
      }
      
      // Look for the last scheduled event
      const lastEvent = await this.eventModel
        .findOne({ isCompleted: false })
        .sort({ startDate: -1 })
        .exec();

      if (!lastEvent) {
        await this.createNextEvent();
        return;
      }

      // Calculate time until next event should be created (1 minute interval)
      const timeSinceLastEvent = now.getTime() - lastEvent.startDate.getTime();
      const oneMinute = 1 * 60 * 1000;

      if (timeSinceLastEvent >= oneMinute) {
        await this.createNextEvent();
      }

      // Only fill schedule occasionally to prevent flood
      if (Math.random() < 0.3) { // 30% chance to fill schedule
        await this.fillEventSchedule();
      }
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error checking event schedule:', error);
      this.handleDatabaseError(error);
    } finally {
      this.isSchedulerRunning = false;
      this.releaseEventCreationLock();
    }
  }

  private async fillEventSchedule(): Promise<void> {
    if (!await this.acquireEventCreationLock()) {
      return;
    }

    try {
      const now = new Date();
      const lookAheadTime = 30 * 60 * 1000; // 🔥 REDUCE to 30 minutes only
      const targetTime = new Date(now.getTime() + lookAheadTime);

      const lastEvent = await this.eventModel
        .findOne({ isCompleted: false })
        .sort({ startDate: -1 })
        .exec();

      if (!lastEvent) {
        return;
      }

      let nextEventTime = new Date(lastEvent.startDate.getTime() + 1 * 60 * 1000);
      let eventsCreated = 0;
      const MAX_EVENTS_TO_CREATE = 5; // 🔥 REDUCE to 5 events max

      while (nextEventTime.getTime() < targetTime.getTime() && eventsCreated < MAX_EVENTS_TO_CREATE) {
        // 🔥 IMPROVED DUPLICATE CHECK
        const existingEvent = await this.eventModel
          .findOne({
            startDate: {
              $gte: new Date(nextEventTime.getTime() - 10 * 1000), // 10-second window
              $lte: new Date(nextEventTime.getTime() + 10 * 1000),
            },
            isCompleted: false,
          })
          .exec();

        if (!existingEvent) {
          const theme = `Auto Event - ${nextEventTime.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}`;

          await this.createEvent(theme, nextEventTime, 5, 2);
       
          eventsCreated++;
        }

        // Move to next time slot (1 minute later)
        nextEventTime = new Date(nextEventTime.getTime() + 1 * 60 * 1000);
      }

      if (eventsCreated > 0) {
     
      }
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error filling event schedule:', error);
      this.handleDatabaseError(error);
    } finally {
      this.releaseEventCreationLock();
    }
  }

  private async createNextEvent(): Promise<void> {
    if (!await this.acquireEventCreationLock()) {
      return;
    }

    try {
      const now = new Date();
      
      // Check if a quiz is active before creating a new event
      const gatewayService = (global as any).gatewayService;
      if (gatewayService && gatewayService.isGlobalQuizActivePublic && gatewayService.isGlobalQuizActivePublic()) {
 
        return;
      }
      
      const lastEvent = await this.eventModel
        .findOne()
        .sort({ startDate: -1 })
        .exec();

      let nextEventTime: Date;

      if (lastEvent && !lastEvent.isCompleted) {
        // Schedule 1 minute after the last event
        nextEventTime = new Date(lastEvent.startDate.getTime() + 1 * 60 * 1000);

        // If the calculated time is in the past, schedule for 1 minute from now
        if (nextEventTime.getTime() <= now.getTime()) {
          nextEventTime = new Date(now.getTime() + 1 * 60 * 1000);
        }
      } else {
        // No events or last event is completed, schedule for 1 minute from now
        nextEventTime = new Date(now.getTime() + 1 * 60 * 1000);
      }

      // Ensure the event is at least 1 minute in the future
      const minTime = new Date(now.getTime() + 1 * 60 * 1000);
      if (nextEventTime.getTime() < minTime.getTime()) {
        nextEventTime = minTime;
      }

      const theme = `Auto Event - ${nextEventTime.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })}`;

      await this.createEvent(theme, nextEventTime, 5, 2);
   
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error creating next event:', error);
      this.handleDatabaseError(error);
    } finally {
      this.releaseEventCreationLock();
    }
  }

  private async checkAndOpenLobbies(): Promise<void> {
    try {
      const now = new Date();
      
      // Find events that should have their lobby open now (1 minute before start)
      const eventsToOpen = await this.eventModel
        .find({
          isCompleted: false,
          lobbyOpen: false,
          startDate: {
            $gte: new Date(now.getTime()),
            $lte: new Date(now.getTime() + 1 * 60 * 1000),
          },
        })
        .exec();

      for (const event of eventsToOpen) {
        const timeUntilEvent = event.startDate.getTime() - now.getTime();
        
        // Open lobby if we're within the 1-minute window before event start
        if (timeUntilEvent <= 1 * 60 * 1000 && timeUntilEvent > 0) {
          const eventId = event._id?.toString();
          if (eventId) {
            await this.openLobby(eventId);
           
          }
        }
      }

      if (eventsToOpen.length > 0) {
    
      }
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error opening lobbies:', error);
      this.handleDatabaseError(error);
    }
  }

  private handleDatabaseError(error: any): void {
    console.error('💾 Database error:', error);
    this.isDatabaseConnected = false;
    
    // Try to reconnect after 5 seconds
    setTimeout(async () => {
      try {
        await this.eventModel.findOne().exec();
        this.isDatabaseConnected = true;
        console.log('✅ Database reconnected');
      } catch (reconnectError) {
        console.error('❌ Database reconnection failed:', reconnectError);
      }
    }, 5000);
  }

  private async updateEventSchemaForExistingEvents(): Promise<void> {
    try {
      // Mettre à jour les événements existants sans completedAt
      await this.eventModel.updateMany(
        { completedAt: { $exists: false }, isCompleted: true },
        { 
          completedAt: new Date(), 
          nextEventCreated: false 
        }
      ).exec();

      // Mettre à jour les événements existants sans nextEventCreated
      await this.eventModel.updateMany(
        { nextEventCreated: { $exists: false } },
        { nextEventCreated: false }
      ).exec();
      
      console.log('✅ Event schema updated for existing events');
    } catch (error) {
      console.error('❌ Error updating event schema:', error);
    }
  }

  // 🔥 NEW: Emergency reset method
  async emergencyReset(): Promise<void> {
    try {
      console.log('🚨 EMERGENCY RESET: Clearing all events');
      
      // Stop all schedulers first
      this.emergencyStopSchedulers();
      
      // Delete all events
      await this.eventModel.deleteMany({});
      console.log('✅ All events deleted');
      
      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Create just one initial event
      const startDate = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes from now
      await this.createEvent(
        'Initial Event - Reset', 
        startDate, 
        5, 
        2
      );
      
      console.log('✅ Single event created');
      
      // Start schedulers safely
      this.startSchedulersSafely();
      
    } catch (error) {
      console.error('❌ Emergency reset failed:', error);
    }
  }

  // Database health check method
  async checkDatabaseHealth(): Promise<boolean> {
    try {
      await this.eventModel.findOne().exec();
      this.isDatabaseConnected = true;
      return true;
    } catch (error) {
      console.error('❌ Database health check failed:', error);
      this.isDatabaseConnected = false;
      return false;
    }
  }

  // Reset events for testing
  async resetEventsForTesting(): Promise<void> {
    try {
      // Delete all existing events
      await this.eventModel.deleteMany({});
  
      
      // Create a new event starting in 1 minute for testing
      const startDate = new Date(Date.now() + 1 * 60 * 1000);
      await this.createEvent(
        'Test Event - Lobby in 1 minute', 
        startDate, 
        5, 
        2
      );
    
    } catch (error) {
      console.error('❌ Error resetting events:', error);
    }
  }

  // Complete event method with automatic next event creation
  async completeEvent(eventId: string, winner: string): Promise<Event> {
    try {
      const result = await this.eventModel.findOneAndUpdate(
        { _id: eventId },
        { 
          $set: { 
            isCompleted: true,
            winner: winner,
            completedAt: new Date()
          } 
        },
        { new: true }
      ).exec();

      if (!result) {
        throw new Error(`Événement ${eventId} non trouvé`);
      }

      console.log(`🏁 Événement ${result.theme} complété avec gagnant: ${winner}`);
      return result;
    } catch (error) {
      console.error(`💾 Erreur base de données pour l'événement ${eventId}:`, error);
      
      // 🔥 CORRECTION: Relancer l'erreur pour que l'appelant puisse la gérer
      throw error;
    }
  }

  // Create event with new fields - UPDATED WITH DUPLICATE PROTECTION
  async createEvent(
    theme: string,
    startDate: Date,
    numberOfQuestions: number,
    minPlayers: number = 2,
  ): Promise<Event> {
    // 🔥 CHECK FOR DUPLICATES BEFORE CREATING
    const existingEvent = await this.eventModel.findOne({
      theme,
      startDate: {
        $gte: new Date(startDate.getTime() - 30 * 1000),
        $lte: new Date(startDate.getTime() + 30 * 1000),
      },
      isCompleted: false
    }).exec();

    if (existingEvent) {
    
      return existingEvent;
    }

    try {
      const event = new this.eventModel({
        theme,
        startDate,
        numberOfQuestions,
        minPlayers,
        lobbyOpen: false,
        isStarted: false,
        isCompleted: false,
        completedAt: null,
        nextEventCreated: false
      });
      
      const result = await event.save();
      this.isDatabaseConnected = true;
      
      console.log(`🎯 Event created: ${theme} at ${startDate}`);
      return result;
    } catch (error) {
      console.error('❌ Error creating event:', error);
      this.handleDatabaseError(error);
      throw error;
    }
  }

  // Existing methods remain the same
  async getEventsInLobbyWindow(): Promise<Event[]> {
    try {
      const now = new Date();
      const twoMinutesBefore = new Date(now.getTime() - 2 * 60 * 1000);

      return await this.eventModel
        .find({
          isCompleted: false,
          startDate: {
            $gte: twoMinutesBefore,
            $lte: now,
          },
        })
        .sort({ startDate: 1 })
        .exec();
    } catch (error) {
      console.error('❌ Error getting events in lobby window:', error);
      this.handleDatabaseError(error);
      return [];
    }
  }

  // nettoyer les événements passés
  private async cleanupPastEvents(): Promise<void> {
    try {
      const now = new Date();
      const pastEvents = await this.eventModel
        .find({
          isCompleted: false,
          startDate: { $lte: now }
        })
        .exec();

      for (const event of pastEvents) {
    
        await this.eventModel.findByIdAndUpdate(
          event._id,
          { 
            isCompleted: true,
            completedAt: now,
            nextEventCreated: false
          }
        ).exec();
      }

      if (pastEvents.length > 0) {
      
      }
    } catch (error) {
      console.error('❌ Error cleaning up past events:', error);
    }
  }

  // Appeler cette méthode périodiquement
  private startCleanupScheduler(): void {
    setInterval(async () => {
      await this.cleanupPastEvents();
    }, 30 * 1000); // Toutes les 30 secondes
  }

  async getNextEvent(): Promise<Event | null> {
    try {
      const now = new Date();
      const result = await this.eventModel
        .findOne({
          isCompleted: false,
          startDate: { $gt: now }, // 🔥 S'assurer que c'est dans le futur
        })
        .sort({ startDate: 1 })
        .exec();
      
      this.isDatabaseConnected = true;
      
      if (result) {
     
      } else {
  
      }
      
      return result;
    } catch (error) {
      console.error('❌ Error getting next event:', error);
      this.handleDatabaseError(error);
      return null;
    }
  }

  async openLobby(eventId: string): Promise<Event | null> {
    try {
    
      const result = await this.eventModel
        .findByIdAndUpdate(eventId, { lobbyOpen: true }, { new: true })
        .exec();

      if (result) {
     
      } else {
  
      }

      this.isDatabaseConnected = true;
      return result;
    } catch (error) {
      console.error('❌ Error opening lobby:', error);
      this.handleDatabaseError(error);
      return null;
    }
  }

  async findActiveEvents(): Promise<Event[]> {
    try {
      const result = await this.eventModel
        .find({ isCompleted: false })
        .sort({ startDate: 1 })
        .exec();
      this.isDatabaseConnected = true;
      return result;
    } catch (error) {
      console.error('❌ Error finding active events:', error);
      this.handleDatabaseError(error);
      return [];
    }
  }

  async getEventsReadyForLobby(): Promise<Event[]> {
    try {
      const now = new Date();
      const oneMinuteFromNow = new Date(now.getTime() + 1 * 60 * 1000);

      const result = await this.eventModel
        .find({
          isCompleted: false,
          startDate: {
            $lte: oneMinuteFromNow,
            $gt: now,
          },
          lobbyOpen: false,
        })
        .sort({ startDate: 1 })
        .exec();
      this.isDatabaseConnected = true;
      return result;
    } catch (error) {
      console.error('❌ Error getting events ready for lobby:', error);
      this.handleDatabaseError(error);
      return [];
    }
  }

  async startEvent(eventId: string): Promise<Event | null> {
    try {
  
      const result = await this.eventModel
        .findByIdAndUpdate(eventId, { isStarted: true }, { new: true })
        .exec();

      if (result) {
     
      } else {
    
      }

      this.isDatabaseConnected = true;
      return result;
    } catch (error) {
      console.error('❌ Error starting event:', error);
      this.handleDatabaseError(error);
      return null;
    }
  }

  async updateEvent(eventId: string, updates: Partial<Event>): Promise<Event | null> {
    try {
      const result = await this.eventModel
        .findByIdAndUpdate(eventId, updates, { new: true })
        .exec();
      this.isDatabaseConnected = true;
      return result;
    } catch (error) {
      console.error('❌ Error updating event:', error);
      this.handleDatabaseError(error);
      return null;
    }
  }

  async getScheduleOverview(): Promise<{
    upcomingEvents: Event[];
    nextLobbyOpen: Date | null;
  }> {
    try {
      const upcomingEvents = await this.findActiveEvents();
      const nextEvent = upcomingEvents[0];

      let nextLobbyOpen: Date | null = null;
      if (nextEvent && !nextEvent.lobbyOpen) {
        nextLobbyOpen = new Date(nextEvent.startDate.getTime() - 1 * 60 * 1000);
      }

      this.isDatabaseConnected = true;
      return {
        upcomingEvents,
        nextLobbyOpen,
      };
    } catch (error) {
      console.error('❌ Error getting schedule overview:', error);
      this.handleDatabaseError(error);
      return {
        upcomingEvents: [],
        nextLobbyOpen: null,
      };
    }
  }
}