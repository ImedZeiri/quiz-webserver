import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private eventSchedulerInterval: NodeJS.Timeout;
  private lobbySchedulerInterval: NodeJS.Timeout;
  private eventCompletionInterval: NodeJS.Timeout;
  private isDatabaseConnected = true;

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

 onModuleInit() {
  console.log('🚀 EventService initializing...');
  this.startEventScheduler();
  this.startLobbyScheduler();
  this.startEventCompletionChecker();
  this.startCleanupScheduler(); // 🔥 NOUVEAU
  this.initializeEvents();
}

  onModuleDestroy() {
    console.log('🛑 EventService shutting down...');
    if (this.eventSchedulerInterval) {
      clearInterval(this.eventSchedulerInterval);
    }
    if (this.lobbySchedulerInterval) {
      clearInterval(this.lobbySchedulerInterval);
    }
    if (this.eventCompletionInterval) {
      clearInterval(this.eventCompletionInterval);
    }
  }

  private startEventCompletionChecker(): void {
    // Vérifier toutes les 30 secondes les événements terminés
    this.eventCompletionInterval = setInterval(async () => {
      if (this.isDatabaseConnected) {
        await this.checkCompletedEventsAndCreateNew();
      }
    }, 30 * 1000);

    // Exécuter immédiatement au démarrage
    this.checkCompletedEventsAndCreateNew();
  }

private async checkCompletedEventsAndCreateNew(): Promise<void> {
  try {
    const now = new Date();
    
    const recentlyCompletedEvents = await this.eventModel
      .find({
        isCompleted: true,
        completedAt: {
          $gte: new Date(now.getTime() - 2 * 60 * 1000),
          $lte: now
        },
        nextEventCreated: { $ne: true }
      })
      .sort({ completedAt: -1 })
      .exec();

    for (const completedEvent of recentlyCompletedEvents) {
      console.log(`🔄 Processing completed event: ${completedEvent.theme}`);
      
      // 🔥 CORRECTION: Vérification de type sécurisée
      if (!completedEvent.completedAt) {
        console.log(`⚠️ Event ${completedEvent.theme} has null completedAt, skipping`);
        continue;
      }
      
      const gatewayService = (global as any).gatewayService;
      if (gatewayService?.isGlobalQuizActivePublic?.()) {
        console.log('🚫 Quiz in progress - postponing new event creation');
        continue;
      }

      // 🔥 CORRECTION: Utilisation sécurisée de completedAt
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

      console.log(`✅ Created new event: ${theme} at ${nextEventTime}`);
    }

    this.isDatabaseConnected = true;
  } catch (error) {
    console.error('❌ Error in checkCompletedEventsAndCreateNew:', error);
    this.handleDatabaseError(error);
  }
}

private async initializeEvents(): Promise<void> {
  try {
    console.log('🚀 Initializing event schedule...');

    await this.updateEventSchemaForExistingEvents();

    const now = new Date();
    const recentlyCompletedWithoutNextEvent = await this.eventModel
      .find({
        isCompleted: true,
        completedAt: {
          $gte: new Date(now.getTime() - 5 * 60 * 1000),
        },
        nextEventCreated: false
      })
      .sort({ completedAt: -1 })
      .exec();

    for (const completedEvent of recentlyCompletedWithoutNextEvent) {
      // 🔥 CORRECTION: Vérification de type sécurisée
      if (!completedEvent.completedAt) {
        console.log(`⚠️ Event ${completedEvent.theme} has null completedAt, skipping`);
        continue;
      }
      
      const nextEventTime = new Date(completedEvent.completedAt.getTime() + 1 * 60 * 1000);
      
      if (nextEventTime.getTime() > now.getTime()) {
        const theme = `Auto Event - ${nextEventTime.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}`;

        await this.createEvent(theme, nextEventTime, 5, 2);
        console.log(`✅ Created event for recently completed: ${theme} at ${nextEventTime}`);

        await this.eventModel.findByIdAndUpdate(
          completedEvent._id,
          { nextEventCreated: true }
        ).exec();
      }
    }

    const upcomingEvents = await this.eventModel
      .find({
        isCompleted: false,
        startDate: { $gt: new Date() },
      })
      .sort({ startDate: 1 })
      .exec();

    if (upcomingEvents.length === 0) {
      await this.createNextEvent();
      console.log('✅ Created initial event');
    } else {
      console.log(`⏭️ Found ${upcomingEvents.length} upcoming events`);
      await this.fillEventSchedule();
    }
    
    this.isDatabaseConnected = true;
  } catch (error) {
    console.error('❌ Error initializing events:', error);
    this.isDatabaseConnected = false;
    setTimeout(() => this.initializeEvents(), 10000);
  }
}



  private startEventScheduler(): void {
    // Check every minute for event scheduling needs
    this.eventSchedulerInterval = setInterval(async () => {
      if (this.isDatabaseConnected) {
        await this.checkEventSchedule();
      }
    }, 60 * 1000);

    // Run immediately on startup
    this.checkEventSchedule();
  }

  private startLobbyScheduler(): void {
    // Check every 30 seconds for lobbies that need to be opened
    this.lobbySchedulerInterval = setInterval(async () => {
      if (this.isDatabaseConnected) {
        await this.checkAndOpenLobbies();
      }
    }, 30 * 1000);

    // Run immediately on startup
    this.checkAndOpenLobbies();
  }

  private async checkEventSchedule(): Promise<void> {
    try {
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

      await this.fillEventSchedule();
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error checking event schedule:', error);
      this.handleDatabaseError(error);
    }
  }

  private async fillEventSchedule(): Promise<void> {
    try {
      const now = new Date();
      const lookAheadTime = 2 * 60 * 60 * 1000; // Look ahead 2 hours
      const targetTime = new Date(now.getTime() + lookAheadTime);

      const lastEvent = await this.eventModel
        .findOne({ isCompleted: false })
        .sort({ startDate: -1 })
        .exec();

      if (!lastEvent) {
        await this.createNextEvent();
        return;
      }

      let currentLastEvent = lastEvent;

      while (currentLastEvent.startDate.getTime() < targetTime.getTime()) {
        const nextEventTime = new Date(
          currentLastEvent.startDate.getTime() + 1 * 60 * 1000,
        );

        // Check if event already exists at this time
        const existingEvent = await this.eventModel
          .findOne({
            startDate: {
              $gte: new Date(nextEventTime.getTime() - 1 * 60 * 1000),
              $lte: new Date(nextEventTime.getTime() + 1 * 60 * 1000),
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
          console.log(`✅ Scheduled event: ${theme} at ${nextEventTime}`);
        }

        // Update currentLastEvent for next iteration
        const newLastEvent = await this.eventModel
          .findOne({ isCompleted: false })
          .sort({ startDate: -1 })
          .exec();

        if (!newLastEvent) {
          break;
        }

        // Safe type comparison using toString()
        const newLastEventId = newLastEvent._id?.toString();
        const currentLastEventId = currentLastEvent._id?.toString();

        if (newLastEventId === currentLastEventId) {
          break;
        }

        currentLastEvent = newLastEvent;
      }
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error filling event schedule:', error);
      this.handleDatabaseError(error);
    }
  }

  private async createNextEvent(): Promise<void> {
    try {
      const now = new Date();
      
      // Check if a quiz is active before creating a new event
      const gatewayService = (global as any).gatewayService;
      if (gatewayService && gatewayService.isGlobalQuizActivePublic && gatewayService.isGlobalQuizActivePublic()) {
        console.log('🚫 Quiz in progress - cancelling event creation');
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
      console.log(`✅ Created next event: ${theme} at ${nextEventTime}`);
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error creating next event:', error);
      this.handleDatabaseError(error);
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
            console.log(
              `🔓 Auto-opened lobby for event: "${event.theme}" starting in ${Math.round(timeUntilEvent / 1000)}s`
            );
          }
        }
      }

      if (eventsToOpen.length > 0) {
        console.log(`✅ Opened ${eventsToOpen.length} lobby/lobbies`);
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
      console.log('🧹 Cleared all existing events');
      
      // Create a new event starting in 1 minute for testing
      const startDate = new Date(Date.now() + 1 * 60 * 1000);
      await this.createEvent(
        'Test Event - Lobby in 1 minute', 
        startDate, 
        5, 
        2
      );
      console.log('✅ Created test event');
    } catch (error) {
      console.error('❌ Error resetting events:', error);
    }
  }

  // Complete event method with automatic next event creation
async completeEvent(eventId: string, winner: string): Promise<Event> {
  try {
    console.log(`🏆 Saving winner for event ${eventId}: ${winner}`);
    
    const result = await this.eventModel.findOneAndUpdate(
      { _id: eventId },
      { 
        $set: { 
          isCompleted: true,
          winner: winner, // 🔥 CORRECTION: Bien sauvegarder le gagnant
          completedAt: new Date()
        } 
      },
      { 
        new: true, 
        runValidators: true // 🔥 AJOUT: Valider les champs
      }
    ).exec();

    if (!result) {
      throw new Error(`Événement ${eventId} non trouvé`);
    }

    console.log(`✅ Event ${result.theme} completed with winner: ${winner}`);
    console.log(`📊 Event document after completion:`, {
      id: result._id,
      theme: result.theme,
      winner: result.winner,
      isCompleted: result.isCompleted,
      completedAt: result.completedAt
    });
    
    return result;
  } catch (error) {
    console.error(`💾 Database error for event ${eventId}:`, error);
    throw error;
  }
}

  // Create event with new fields
  async createEvent(
    theme: string,
    startDate: Date,
    numberOfQuestions: number,
    minPlayers: number = 2,
  ): Promise<Event> {
    try {
      const event = new this.eventModel({
        theme,
        startDate,
        numberOfQuestions,
        minPlayers,
        lobbyOpen: false,
        isStarted: false,
        isCompleted: false,
        completedAt: null, // Initialiser comme null
        nextEventCreated: false // Initialiser le flag
      });
      const result = await event.save();
      this.isDatabaseConnected = true;
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


  private getSafeCompletedAt(completedEvent: Event): Date {
  // 🔥 CORRECTION: Retourne une date sécurisée
  if (completedEvent.completedAt) {
    return completedEvent.completedAt;
  }
  
  // Si completedAt est null, utiliser startDate + 2 minutes comme fallback
  const fallbackDate = new Date(completedEvent.startDate.getTime() + 2 * 60 * 1000);
  console.log(`⚠️ Using fallback completedAt for ${completedEvent.theme}: ${fallbackDate}`);
  return fallbackDate;
}

  //  nettoyer les événements passés
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
      console.log(`🧹 Nettoyage événement passé: ${event.theme}`);
      await this.eventModel.findByIdAndUpdate(
        event._id,
        { 
          isCompleted: true,
          completedAt: now, // 🔥 CORRECTION: Toujours définir completedAt
          nextEventCreated: false
        }
      ).exec();
    }

    if (pastEvents.length > 0) {
      console.log(`✅ ${pastEvents.length} événement(s) passé(s) nettoyé(s)`);
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
      console.log(`📅 Prochain événement trouvé: ${result.theme} à ${result.startDate}`);
    } else {
      console.log('📅 Aucun prochain événement trouvé');
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
      console.log(`🔓 Opening lobby for event ${eventId}`);
      const result = await this.eventModel
        .findByIdAndUpdate(eventId, { lobbyOpen: true }, { new: true })
        .exec();

      if (result) {
        console.log(`✅ Lobby opened successfully for: ${result.theme}`);
      } else {
        console.log(`❌ Failed to open lobby for event ${eventId}`);
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
      console.log(`🚀 Starting event ${eventId}`);
      const result = await this.eventModel
        .findByIdAndUpdate(eventId, { isStarted: true }, { new: true })
        .exec();

      if (result) {
        console.log(`✅ Event started successfully: ${result.theme}`);
      } else {
        console.log(`❌ Failed to start event ${eventId}`);
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