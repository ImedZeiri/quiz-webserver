import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Event } from '../model/event.entity';

@Injectable()
export class EventService implements OnModuleInit, OnModuleDestroy {
  private eventSchedulerInterval: NodeJS.Timeout;
  private lobbySchedulerInterval: NodeJS.Timeout;

  constructor(
    @InjectModel(Event.name)
    private readonly eventModel: Model<Event>,
  ) {}

  onModuleInit() {
    // Start both schedulers when the module initializes
    this.startEventScheduler();
    this.startLobbyScheduler();

    // Initialize events on startup
    this.initializeEvents();
  }

  onModuleDestroy() {
    // Clear intervals when the module is destroyed
    if (this.eventSchedulerInterval) {
      clearInterval(this.eventSchedulerInterval);
    }
    if (this.lobbySchedulerInterval) {
      clearInterval(this.lobbySchedulerInterval);
    }
  }

  private async initializeEvents(): Promise<void> {
    try {
      console.log('🚀 Initializing event schedule...');

      // Check for existing upcoming events
      const upcomingEvents = await this.eventModel
        .find({
          isCompleted: false,
          startDate: { $gt: new Date() },
        })
        .sort({ startDate: 1 })
        .exec();

      if (upcomingEvents.length === 0) {
        // No upcoming events, create the first one starting in 15 minutes
        await this.createNextEvent();
        console.log('✅ Created initial event');
      } else {
        console.log(`⏭️ Found ${upcomingEvents.length} upcoming events`);

        // Ensure we have events scheduled for the next few hours
        await this.fillEventSchedule();
      }
    } catch (error) {
      console.error('❌ Error initializing events:', error);
    }
  }

  private startEventScheduler(): void {
    // Check every minute for event scheduling needs
    this.eventSchedulerInterval = setInterval(async () => {
      await this.checkEventSchedule();
    }, 60 * 1000);

    // Run immediately on startup
    this.checkEventSchedule();
  }

  private startLobbyScheduler(): void {
    // Check every 30 seconds for lobbies that need to be opened
    this.lobbySchedulerInterval = setInterval(async () => {
      await this.checkAndOpenLobbies();
    }, 30 * 1000);

    // Run immediately on startup
    this.checkAndOpenLobbies();
  }

  private async checkEventSchedule(): Promise<void> {
    try {
      const now = new Date();

      // Look for the last scheduled event
      const lastEvent = await this.eventModel
        .findOne({ isCompleted: false })
        .sort({ startDate: -1 })
        .exec();

      if (!lastEvent) {
        // No events found, create one
        await this.createNextEvent();
        return;
      }

      // Calculate time until next event should be created
      const timeSinceLastEvent = now.getTime() - lastEvent.startDate.getTime();
      const fifteenMinutes = 15 * 60 * 1000;

      if (timeSinceLastEvent >= fifteenMinutes) {
        // It's time to create a new event
        await this.createNextEvent();
      }

      // Also ensure we have events scheduled for the next few hours
      await this.fillEventSchedule();
    } catch (error) {
      console.error('❌ Error checking event schedule:', error);
    }
  }

  private async fillEventSchedule(): Promise<void> {
    try {
      const now = new Date();
      const lookAheadTime = 2 * 60 * 60 * 1000; // Look ahead 2 hours
      const targetTime = new Date(now.getTime() + lookAheadTime);

      // Find the last scheduled event
      const lastEvent = await this.eventModel
        .findOne({ isCompleted: false })
        .sort({ startDate: -1 })
        .exec();

      if (!lastEvent) {
        await this.createNextEvent();
        return;
      }

      let currentLastEvent = lastEvent;

      // Keep creating events until we're scheduled 2 hours ahead
<<<<<<< HEAD
      while (lastEvent.startDate.getTime() < targetTime.getTime()) {
        const nextEventTime = new Date(
          lastEvent.startDate.getTime() + 15 * 60 * 1000,
        );

=======
      while (currentLastEvent.startDate.getTime() < targetTime.getTime()) {
        const nextEventTime = new Date(currentLastEvent.startDate.getTime() + 15 * 60 * 1000);
        
>>>>>>> c094f374848278427bd15138d4bf2f1caea73c37
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
          const theme = `Auto Event - ${nextEventTime.toLocaleTimeString(
            'en-US',
            {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            },
          )}`;

          await this.createEvent(theme, nextEventTime, 5, 2);
          console.log(`✅ Scheduled event: ${theme} at ${nextEventTime}`);
        }

        // Update currentLastEvent for next iteration
        const newLastEvent = await this.eventModel
          .findOne({ isCompleted: false })
          .sort({ startDate: -1 })
          .exec();
<<<<<<< HEAD

        if (
          !newLastEvent ||
          newLastEvent._id.toString() === lastEvent._id.toString()
        ) {
          break; // No new event was created, break the loop
        }

        lastEvent.startDate = newLastEvent.startDate;
=======
          
        if (!newLastEvent) {
          break; // No events found, break the loop
        }

        // Type-safe ID comparison
        const newLastEventId = (newLastEvent._id as any).toString();
        const currentLastEventId = (currentLastEvent._id as any).toString();
        
        if (newLastEventId === currentLastEventId) {
          break; // No new event was created, break the loop
        }
        
        currentLastEvent = newLastEvent;
>>>>>>> c094f374848278427bd15138d4bf2f1caea73c37
      }
    } catch (error) {
      console.error('❌ Error filling event schedule:', error);
    }
  }

  private async createNextEvent(): Promise<void> {
    try {
      const now = new Date();

      // Find the last event to determine next start time
      const lastEvent = await this.eventModel
        .findOne()
        .sort({ startDate: -1 })
        .exec();

      let nextEventTime: Date;

      if (lastEvent && !lastEvent.isCompleted) {
        // Schedule 15 minutes after the last event
        nextEventTime = new Date(
          lastEvent.startDate.getTime() + 15 * 60 * 1000,
        );

        // If the calculated time is in the past, schedule for 15 minutes from now
        if (nextEventTime.getTime() <= now.getTime()) {
          nextEventTime = new Date(now.getTime() + 15 * 60 * 1000);
        }
      } else {
        // No events or last event is completed, schedule for 15 minutes from now
        nextEventTime = new Date(now.getTime() + 15 * 60 * 1000);
      }

      const theme = `Auto Event - ${nextEventTime.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })}`;

      await this.createEvent(theme, nextEventTime, 5, 2);
      console.log(`✅ Created next event: ${theme} at ${nextEventTime}`);
    } catch (error) {
      console.error('❌ Error creating next event:', error);
    }
  }

  async checkAndOpenLobbies(): Promise<void> {
    try {
      const now = new Date();
      const twoMinutesFromNow = new Date(now.getTime() + 2 * 60 * 1000);

      // Find events that start in exactly 2 minutes (±30 seconds) and don't have lobby open yet
      const eventsToOpen = await this.eventModel
        .find({
          isCompleted: false,
          lobbyOpen: false,
          startDate: {
            $gte: new Date(twoMinutesFromNow.getTime() - 30 * 1000), // 30 seconds before 2-minute mark
            $lte: new Date(twoMinutesFromNow.getTime() + 30 * 1000), // 30 seconds after 2-minute mark
          },
        })
        .exec();

      for (const event of eventsToOpen) {
        await this.openLobby((event._id as any).toString());
        console.log(
          `🔓 Auto-opened lobby for event: "${event.theme}" starting at ${event.startDate.toLocaleTimeString()}`,
        );
      }

      if (eventsToOpen.length > 0) {
        console.log(`✅ Opened ${eventsToOpen.length} lobby/lobbies`);
      }
    } catch (error) {
      console.error('❌ Error opening lobbies:', error);
    }
  }

<<<<<<< HEAD
  async completeEvent(
    eventId: string,
    winnerPhone: string,
  ): Promise<Event | null> {
=======
  async getEventsInLobbyWindow(): Promise<Event[]> {
    const now = new Date();
    const twoMinutesBefore = new Date(now.getTime() - 2 * 60 * 1000);
    
    return this.eventModel.find({
      isCompleted: false,
      startDate: { 
        $gte: twoMinutesBefore,
        $lte: now
      }
    }).sort({ startDate: 1 }).exec();
  }

  async completeEvent(eventId: string, winnerPhone: string): Promise<Event | null> {
>>>>>>> c094f374848278427bd15138d4bf2f1caea73c37
    console.log(`🏁 Completing event ${eventId} with winner: ${winnerPhone}`);

    try {
      const result = await this.eventModel
        .findByIdAndUpdate(
          eventId,
          { winner: winnerPhone, isCompleted: true },
          { new: true },
        )
        .exec();

      if (result) {
        console.log(`✅ Event completed successfully: ${result.theme}`);
<<<<<<< HEAD

        // The event scheduler will automatically create new events
        // so we don't need to manually schedule here
=======
>>>>>>> c094f374848278427bd15138d4bf2f1caea73c37
      } else {
        console.log(`❌ Failed to complete event ${eventId}`);
      }

      return result;
    } catch (error) {
      console.error('❌ Error completing event:', error);
      throw error;
    }
  }

  async createEvent(
    theme: string,
    startDate: Date,
    numberOfQuestions: number,
    minPlayers: number = 2,
  ): Promise<Event> {
    const event = new this.eventModel({
      theme,
      startDate,
      numberOfQuestions,
      minPlayers,
      lobbyOpen: false,
      isStarted: false,
      isCompleted: false,
    });
    return event.save();
  }

  async getNextEvent(): Promise<Event | null> {
    const now = new Date();
    return this.eventModel
      .findOne({
        isCompleted: false,
        startDate: { $gt: now },
      })
      .sort({ startDate: 1 })
      .exec();
  }

  async openLobby(eventId: string): Promise<Event | null> {
    console.log(`🔓 Opening lobby for event ${eventId}`);
    const result = await this.eventModel
      .findByIdAndUpdate(eventId, { lobbyOpen: true }, { new: true })
      .exec();

    if (result) {
      console.log(`✅ Lobby opened successfully for: ${result.theme}`);
    } else {
      console.log(`❌ Failed to open lobby for event ${eventId}`);
    }

    return result;
  }

  async findActiveEvents(): Promise<Event[]> {
    return this.eventModel
      .find({ isCompleted: false })
      .sort({ startDate: 1 })
      .exec();
  }

  async getEventsReadyForLobby(): Promise<Event[]> {
    const now = new Date();
    const twoMinutesFromNow = new Date(now.getTime() + 2 * 60 * 1000);

    return this.eventModel
      .find({
        isCompleted: false,
        startDate: {
          $lte: twoMinutesFromNow,
          $gt: now,
        },
        lobbyOpen: false,
      })
      .sort({ startDate: 1 })
      .exec();
  }

  async startEvent(eventId: string): Promise<Event | null> {
    console.log(`🚀 Starting event ${eventId}`);
    const result = await this.eventModel
      .findByIdAndUpdate(eventId, { isStarted: true }, { new: true })
      .exec();

    if (result) {
      console.log(`✅ Event started successfully: ${result.theme}`);
    } else {
      console.log(`❌ Failed to start event ${eventId}`);
    }

    return result;
  }

  async updateEvent(
    eventId: string,
    updates: Partial<Event>,
  ): Promise<Event | null> {
    const result = await this.eventModel
      .findByIdAndUpdate(eventId, updates, { new: true })
      .exec();
    return result;
  }

  // Utility method to get schedule overview
  async getScheduleOverview(): Promise<{
    upcomingEvents: Event[];
    nextLobbyOpen: Date | null;
  }> {
    const upcomingEvents = await this.findActiveEvents();
    const nextEvent = upcomingEvents[0];

    let nextLobbyOpen: Date | null = null;
    if (nextEvent && !nextEvent.lobbyOpen) {
      nextLobbyOpen = new Date(nextEvent.startDate.getTime() - 2 * 60 * 1000);
    }

    return {
      upcomingEvents,
      nextLobbyOpen,
    };
  }
}
