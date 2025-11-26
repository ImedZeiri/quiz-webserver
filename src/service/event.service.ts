import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private eventSchedulerInterval: NodeJS.Timeout;
  private lobbySchedulerInterval: NodeJS.Timeout;
  private eventCompletionInterval: NodeJS.Timeout;
  private cleanupSchedulerInterval: NodeJS.Timeout;
  private isDatabaseConnected = true;
  private isScheduling = false;

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  async onModuleInit() {
    console.log('🚀 EventService initializing...');
    
    await this.cleanupDuplicateEvents();
    
    setTimeout(() => this.startEventScheduler(), 1000);
    setTimeout(() => this.startLobbyScheduler(), 2000);
    setTimeout(() => this.startEventCompletionChecker(), 3000);
    setTimeout(() => this.startCleanupScheduler(), 4000);
    setTimeout(() => this.initializeEvents(), 5000);
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
    if (this.cleanupSchedulerInterval) {
      clearInterval(this.cleanupSchedulerInterval);
    }
  }

  private async withSchedulingLock<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.isScheduling) {
      console.log('⏳ Scheduling operation already in progress, skipping...');
      return null;
    }
    
    this.isScheduling = true;
    try {
      return await operation();
    } catch (error) {
      console.error('❌ Error in scheduled operation:', error);
      return null;
    } finally {
      this.isScheduling = false;
    }
  }

  // 🔥 FIX: Proper TypeScript type handling for _id
  private async cleanupDuplicateEvents(): Promise<void> {
    try {
      console.log('🧹 Checking for duplicate events...');
      
      const now = new Date();
      const activeEvents = await this.eventModel.find({
        isCompleted: false,
        startDate: { $gte: now }
      }).sort({ startDate: 1 }).exec();

      const eventsToDelete = new Set<string>();
      const seenTimes = new Set<number>();
      
      for (const event of activeEvents) {
        const eventTime = event.startDate.getTime();
        const timeKey = Math.floor(eventTime / 60000);
        
        if (seenTimes.has(timeKey)) {
          // 🔥 FIX: Proper _id access with type assertion
          const eventId = (event._id as Types.ObjectId).toString();
          eventsToDelete.add(eventId);
          console.log(`🗑️ Marking duplicate for deletion: ${event.theme} at ${event.startDate}`);
        } else {
          seenTimes.add(timeKey);
        }
      }

      if (eventsToDelete.size > 0) {
        const deleteIds = Array.from(eventsToDelete);
        await this.eventModel.deleteMany({ _id: { $in: deleteIds } }).exec();
        console.log(`✅ Deleted ${eventsToDelete.size} duplicate events`);
      } else {
        console.log('✅ No duplicate events found');
      }
    } catch (error) {
      console.error('❌ Error cleaning up duplicate events:', error);
    }
  }

  private async createEventAtomically(
    startDate: Date,
    numberOfQuestions: number = 5,
    minPlayers: number = 2
  ): Promise<Event | null> {
    try {
      const theme = `Auto Event - ${startDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })}`;

      const existingEvent = await this.eventModel.findOne({
        theme: { $regex: /^Auto Event -/ },
        startDate: {
          $gte: new Date(startDate.getTime() - 60000),
          $lte: new Date(startDate.getTime() + 60000),
        },
        isCompleted: false,
      }).exec();

      if (existingEvent) {
        console.log(`⏭️ Event already exists at this time: ${existingEvent.theme}`);
        return existingEvent;
      }

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
      console.log(`✅ Created new event: ${theme} at ${startDate}`);
      return result;
    } catch (error) {
      if (error.code === 11000 || error.message?.includes('duplicate')) {
        console.log(`⏭️ Event creation conflict, likely duplicate: ${error.message}`);
        return null;
      }
      console.error('❌ Error creating event atomically:', error);
      throw error;
    }
  }

  private startEventCompletionChecker(): void {
    this.eventCompletionInterval = setInterval(async () => {
      await this.withSchedulingLock(() => this.checkCompletedEventsAndCreateNew());
    }, 30 * 1000);

    setTimeout(() => {
      this.withSchedulingLock(() => this.checkCompletedEventsAndCreateNew());
    }, 1000);
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
        
        if (!completedEvent.completedAt) {
          console.log(`⚠️ Event ${completedEvent.theme} has null completedAt, skipping`);
          continue;
        }
        
        const gatewayService = (global as any).gatewayService;
        if (gatewayService?.isGlobalQuizActivePublic?.()) {
          console.log('🚫 Quiz in progress - postponing new event creation');
          continue;
        }

        const nextEventTime = new Date(completedEvent.completedAt.getTime() + 1 * 60 * 1000);
        
        if (nextEventTime.getTime() <= now.getTime()) {
          nextEventTime.setTime(now.getTime() + 1 * 60 * 1000);
        }

        await this.createEventAtomically(nextEventTime, 5, 2);

        await this.eventModel.findByIdAndUpdate(
          completedEvent._id,
          { nextEventCreated: true }
        ).exec();

        console.log(`✅ Created new event for completed: ${completedEvent.theme}`);
      }

      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error in checkCompletedEventsAndCreateNew:', error);
      this.handleDatabaseError(error);
    }
  }

  private async initializeEvents(): Promise<void> {
    await this.withSchedulingLock(async () => {
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
          if (!completedEvent.completedAt) {
            console.log(`⚠️ Event ${completedEvent.theme} has null completedAt, skipping`);
            continue;
          }
          
          const nextEventTime = new Date(completedEvent.completedAt.getTime() + 1 * 60 * 1000);
          
          if (nextEventTime.getTime() > now.getTime()) {
            await this.createEventAtomically(nextEventTime, 5, 2);
            console.log(`✅ Created event for recently completed: ${completedEvent.theme} at ${nextEventTime}`);

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
    });
  }

  private startEventScheduler(): void {
    this.eventSchedulerInterval = setInterval(async () => {
      await this.withSchedulingLock(() => this.checkEventSchedule());
    }, 60 * 1000);

    setTimeout(() => {
      this.withSchedulingLock(() => this.checkEventSchedule());
    }, 2000);
  }

  private startLobbyScheduler(): void {
    this.lobbySchedulerInterval = setInterval(async () => {
      if (this.isDatabaseConnected) {
        await this.checkAndOpenLobbies();
      }
    }, 30 * 1000);

    this.checkAndOpenLobbies();
  }

  private startCleanupScheduler(): void {
    this.cleanupSchedulerInterval = setInterval(async () => {
      await this.cleanupPastEvents();
    }, 30 * 1000);
  }

  private async checkEventSchedule(): Promise<void> {
    try {
      const now = new Date();
      
      const gatewayService = (global as any).gatewayService;
      if (gatewayService && gatewayService.isGlobalQuizActivePublic && gatewayService.isGlobalQuizActivePublic()) {
        console.log('🚫 Quiz in progress - postponing event creation');
        return;
      }
      
      const lastEvent = await this.eventModel
        .findOne({ isCompleted: false })
        .sort({ startDate: -1 })
        .exec();

      if (!lastEvent) {
        await this.createNextEvent();
        return;
      }

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

  // 🔥 FIX: Proper TypeScript type handling for _id comparisons
  private async fillEventSchedule(): Promise<void> {
    try {
      const now = new Date();
      const lookAheadTime = 2 * 60 * 60 * 1000;
      const targetTime = new Date(now.getTime() + lookAheadTime);

      const upcomingEvents = await this.eventModel
        .find({
          isCompleted: false,
          startDate: { $gte: now }
        })
        .sort({ startDate: 1 })
        .exec();

      if (upcomingEvents.length === 0) {
        const firstEventTime = new Date(now.getTime() + 1 * 60 * 1000);
        await this.createEventAtomically(firstEventTime, 5, 2);
        return;
      }

      let currentTime = new Date(upcomingEvents[0].startDate);
      
      for (let i = 0; i < upcomingEvents.length; i++) {
        const event = upcomingEvents[i];
        const eventTime = new Date(event.startDate);
        
        if (i === 0 && eventTime.getTime() > now.getTime() + 2 * 60 * 1000) {
          const gapEventTime = new Date(now.getTime() + 1 * 60 * 1000);
          await this.createEventAtomically(gapEventTime, 5, 2);
        }

        if (i < upcomingEvents.length - 1) {
          const nextEvent = upcomingEvents[i + 1];
          const nextEventTime = new Date(nextEvent.startDate);
          const gap = nextEventTime.getTime() - eventTime.getTime();
          
          if (gap > 2 * 60 * 1000) {
            const gapEventTime = new Date(eventTime.getTime() + 1 * 60 * 1000);
            await this.createEventAtomically(gapEventTime, 5, 2);
          }
        }
      }

      const lastEvent = upcomingEvents[upcomingEvents.length - 1];
      let lastEventTime = new Date(lastEvent.startDate);
      
      while (lastEventTime.getTime() < targetTime.getTime() - 1 * 60 * 1000) {
        const nextEventTime = new Date(lastEventTime.getTime() + 1 * 60 * 1000);
        
        const existing = await this.eventModel.findOne({
          startDate: {
            $gte: new Date(nextEventTime.getTime() - 30000),
            $lte: new Date(nextEventTime.getTime() + 30000),
          },
          isCompleted: false
        }).exec();

        if (!existing) {
          await this.createEventAtomically(nextEventTime, 5, 2);
        }
        
        const newLastEvent = await this.eventModel
          .findOne({ isCompleted: false })
          .sort({ startDate: -1 })
          .exec();
          
        // 🔥 FIX: Proper _id comparison with type assertions
        if (!newLastEvent) {
          break;
        }

        const newLastEventId = (newLastEvent._id as Types.ObjectId).toString();
        const lastEventId = (lastEvent._id as Types.ObjectId).toString();

        if (newLastEventId === lastEventId) {
          break;
        }
        
        lastEventTime = new Date(newLastEvent.startDate);
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
      
      const gatewayService = (global as any).gatewayService;
      if (gatewayService && gatewayService.isGlobalQuizActivePublic && gatewayService.isGlobalQuizActivePublic()) {
        console.log('🚫 Quiz in progress - cancelling event creation');
        return;
      }
      
      const lastEvent = await this.eventModel
        .findOne({ isCompleted: false })
        .sort({ startDate: -1 })
        .exec();

      let nextEventTime: Date;

      if (lastEvent) {
        nextEventTime = new Date(lastEvent.startDate.getTime() + 1 * 60 * 1000);
        
        if (nextEventTime.getTime() <= now.getTime()) {
          nextEventTime = new Date(now.getTime() + 1 * 60 * 1000);
        }
      } else {
        nextEventTime = new Date(now.getTime() + 1 * 60 * 1000);
      }

      const minTime = new Date(now.getTime() + 1 * 60 * 1000);
      if (nextEventTime.getTime() < minTime.getTime()) {
        nextEventTime = minTime;
      }

      await this.createEventAtomically(nextEventTime, 5, 2);
      
      this.isDatabaseConnected = true;
    } catch (error) {
      console.error('❌ Error creating next event:', error);
      this.handleDatabaseError(error);
    }
  }

  private async checkAndOpenLobbies(): Promise<void> {
    try {
      const now = new Date();
      
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
        
        if (timeUntilEvent <= 1 * 60 * 1000 && timeUntilEvent > 0) {
          const eventId = (event._id as Types.ObjectId).toString();
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
      await this.eventModel.updateMany(
        { completedAt: { $exists: false }, isCompleted: true },
        { 
          completedAt: new Date(), 
          nextEventCreated: false 
        }
      ).exec();

      await this.eventModel.updateMany(
        { nextEventCreated: { $exists: false } },
        { nextEventCreated: false }
      ).exec();
      
      console.log('✅ Event schema updated for existing events');
    } catch (error) {
      console.error('❌ Error updating event schema:', error);
    }
  }

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

  async resetEventsForTesting(): Promise<void> {
    try {
      await this.eventModel.deleteMany({});
      console.log('🧹 Cleared all existing events');
      
      const startDate = new Date(Date.now() + 1 * 60 * 1000);
      await this.createEventAtomically(startDate, 5, 2);
      console.log('✅ Created test event');
    } catch (error) {
      console.error('❌ Error resetting events:', error);
    }
  }

  async completeEvent(eventId: string, winner: string): Promise<Event> {
    try {
      console.log(`🏆 Saving winner for event ${eventId}: ${winner}`);
      
      const result = await this.eventModel.findOneAndUpdate(
        { _id: eventId },
        { 
          $set: { 
            isCompleted: true,
            winner: winner,
            completedAt: new Date()
          } 
        },
        { 
          new: true, 
          runValidators: true
        }
      ).exec();

      if (!result) {
        throw new Error(`Événement ${eventId} non trouvé`);
      }

      console.log(`✅ Event ${result.theme} completed with winner: ${winner}`);
      
      return result;
    } catch (error) {
      console.error(`💾 Database error for event ${eventId}:`, error);
      throw error;
    }
  }

  async createEvent(
    theme: string,
    startDate: Date,
    numberOfQuestions: number,
    minPlayers: number = 2,
  ): Promise<Event> {
    const event = await this.createEventAtomically(startDate, numberOfQuestions, minPlayers);
    if (!event) {
      throw new Error('Failed to create event - likely duplicate');
    }
    return event;
  }

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
    if (completedEvent.completedAt) {
      return completedEvent.completedAt;
    }
    
    const fallbackDate = new Date(completedEvent.startDate.getTime() + 2 * 60 * 1000);
    console.log(`⚠️ Using fallback completedAt for ${completedEvent.theme}: ${fallbackDate}`);
    return fallbackDate;
  }

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
            completedAt: now,
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

  async getNextEvent(): Promise<Event | null> {
    try {
      const now = new Date();
      const result = await this.eventModel
        .findOne({
          isCompleted: false,
          startDate: { $gt: now },
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