import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { loadConfig } from '../config';

interface SupabaseUser {
  id: string;
  email?: string;
  user_metadata?: { display_name?: string };
}

interface SupabaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: SupabaseUser;
}

interface AppSession {
  session_hash: string;
  user_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  expires_at: string;
  revoked_at: string | null;
  refresh_lock_id: string | null;
  refresh_lock_until: string | null;
}

interface SupabaseProfile {
  id: string;
  display_name: string;
  role: 'learner' | 'instructor' | 'admin';
}

interface EnrollmentRow {
  course_id: string;
}

interface DatabaseCourse {
  id: string;
  title: string;
  instructor?: { display_name?: string } | null;
  category: string;
  level: string;
  duration_minutes: number;
  lesson_count: number;
  progress?: number;
  accent: string;
  icon: string;
  description: string;
}

interface ProgressRow {
  course_id: string;
  progress_percent: number;
  minutes_spent: number;
}

export interface ClassroomMessage {
  id: string;
  course_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

export interface NotificationRecord {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_LOCK_MS = 15000;
const COOKIE_MAX_AGE_MS = SESSION_LIFETIME_MS;
const DAY_MS = 24 * 60 * 60 * 1000;
const REVOKED_SESSION_RETENTION_MS = 30 * DAY_MS;
const SESSION_CLEANUP_INTERVAL_MS = DAY_MS;

export class SessionRefreshInProgressException extends ServiceUnavailableException {
  constructor() {
    super('Session refresh is in progress; retry shortly');
  }
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private sessionCleanupTimer?: NodeJS.Timeout;

  private get config() {
    return loadConfig(process.env);
  }

  private get encryptionKey(): Buffer {
    const key = this.config.authEncryptionKeys?.[this.config.authEncryptionKeyVersion];

    if (!key) {
      throw new ServiceUnavailableException('Authentication is not configured');
    }

    return key;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.isProduction) {
      return;
    }

    const rows = await this.databaseRequest<Array<{ schema_version: number }>>(
      '/api_schema_metadata?schema_version=eq.1&select=schema_version&limit=1',
    );

    if (rows.length !== 1) {
      throw new Error('Required Supabase migration is missing; apply the BE migrations before starting production');
    }

    void this.cleanupStaleSessions().catch(() => {
      this.logger.warn('Initial app-session retention cleanup failed');
    });
    this.sessionCleanupTimer = setInterval(() => {
      void this.cleanupStaleSessions().catch(() => {
        this.logger.warn('Scheduled app-session retention cleanup failed');
      });
    }, SESSION_CLEANUP_INTERVAL_MS);
    this.sessionCleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = undefined;
    }
  }

  private get supabaseUrl(): string {
    const url = this.config.supabaseUrl;

    if (!url) {
      throw new ServiceUnavailableException('Authentication is not configured');
    }

    return url;
  }

  private get publishableKey(): string {
    const key = this.config.supabasePublishableKey;

    if (!key) {
      throw new ServiceUnavailableException('Authentication is not configured');
    }

    return key;
  }

  private get secretKey(): string {
    const key = this.config.supabaseSecretKey;

    if (!key) {
      throw new ServiceUnavailableException('Session storage is not configured');
    }

    return key;
  }

  private hashCookie(cookie: string): string {
    return createHash('sha256').update(cookie).digest('hex');
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

    return `${this.config.authEncryptionKeyVersion}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
  }

  private decrypt(value: string): string {
    const [version, ivValue, tagValue, ciphertext] = value.split(':');

    const key = version ? this.config.authEncryptionKeys?.[version] : undefined;

    if (!key || !ivValue || !tagValue || !ciphertext) {
      throw new ServiceUnavailableException('Stored session has an unsupported encryption version');
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('Stored session could not be decrypted');
    }
  }

  private async authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${this.supabaseUrl}/auth/v1${path}`, {
        ...init,
        signal: AbortSignal.timeout(10000),
        headers: {
          apikey: this.publishableKey,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      });
    } catch {
      throw new ServiceUnavailableException('Authentication provider is unavailable');
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        throw new UnauthorizedException('Invalid credentials or expired session');
      }

      throw new ServiceUnavailableException('Authentication provider is unavailable');
    }

    return payload as T;
  }

  private async databaseRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${this.supabaseUrl}/rest/v1${path}`, {
        ...init,
        signal: AbortSignal.timeout(10000),
        headers: {
          apikey: this.secretKey,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      });
    } catch {
      throw new ServiceUnavailableException('Session storage is unavailable');
    }

    if (!response.ok) {
      throw new ServiceUnavailableException('Session storage is unavailable');
    }

    if (response.status === 204 || init.headers && new Headers(init.headers).get('Prefer')?.includes('return=minimal')) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async loadSession(cookie: string): Promise<AppSession | undefined> {
    const hash = this.hashCookie(cookie);

    return this.loadSessionByHash(hash);
  }

  private async loadSessionByHash(hash: string): Promise<AppSession | undefined> {
    const rows = await this.databaseRequest<AppSession[]>(
      `/app_sessions?session_hash=eq.${hash}&revoked_at=is.null&select=*&limit=1`,
    );

    return rows[0];
  }

  sessionHashForCookie(cookie: string): string {
    return this.hashCookie(cookie);
  }

  async isSessionActive(sessionHash: string, userId: string): Promise<boolean> {
    const rows = await this.databaseRequest<Array<{ expires_at: string }>>(
      `/app_sessions?session_hash=eq.${sessionHash}&user_id=eq.${userId}&revoked_at=is.null&select=expires_at&limit=1`,
    );

    return rows.length === 1 && Date.parse(rows[0].expires_at) > Date.now();
  }

  private async revokeSession(sessionHash: string): Promise<void> {
    await this.databaseRequest(`/app_sessions?session_hash=eq.${sessionHash}&revoked_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString(), refresh_lock_id: null, refresh_lock_until: null }),
    });
  }

  async cleanupStaleSessions(now = new Date()): Promise<void> {
    const revokedBefore = new Date(now.getTime() - REVOKED_SESSION_RETENTION_MS).toISOString();
    const filters = new URLSearchParams({
      or: `(and(revoked_at.is.null,expires_at.lt.${now.toISOString()}),and(revoked_at.not.is.null,revoked_at.lt.${revokedBefore}))`,
    });

    await this.databaseRequest(`/app_sessions?${filters.toString()}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  }

  private async ensureProfile(user: SupabaseUser): Promise<void> {
    await this.databaseRequest('/profiles?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        id: user.id,
        display_name: (user.user_metadata?.display_name || '').slice(0, 120),
        role: 'learner',
      }),
    });
  }

  private async verifyAccessToken(accessToken: string): Promise<AuthenticatedUser | undefined> {
    try {
      const user = await this.authRequest<SupabaseUser>('/user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      return { id: user.id, email: user.email || null };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        return undefined;
      }

      throw error;
    }
  }

  private async revokeSupabaseSession(accessToken: string): Promise<void> {
    await this.authRequest('/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }

  async login(email: string, password: string): Promise<{
    cookie: string;
    cookieMaxAgeMs: number;
    user: AuthenticatedUser;
  }> {
    const tokens = await this.authRequest<SupabaseTokenResponse>('/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    try {
      await this.ensureProfile(tokens.user);
      const cookie = randomBytes(32).toString('base64url');
      const now = Date.now();
      const session: AppSession = {
        session_hash: this.hashCookie(cookie),
        user_id: tokens.user.id,
        access_token_ciphertext: this.encrypt(tokens.access_token),
        refresh_token_ciphertext: this.encrypt(tokens.refresh_token),
        expires_at: new Date(now + SESSION_LIFETIME_MS).toISOString(),
        revoked_at: null,
        refresh_lock_id: null,
        refresh_lock_until: null,
      };

      await this.databaseRequest('/app_sessions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(session),
      });

      return {
        cookie,
        cookieMaxAgeMs: COOKIE_MAX_AGE_MS,
        user: { id: tokens.user.id, email: tokens.user.email || null },
      };
    } catch (error) {
      await this.revokeSupabaseSession(tokens.access_token);
      throw error;
    }
  }

  async getAuthenticatedUser(cookie: string): Promise<AuthenticatedUser | undefined> {
    let session = await this.loadSession(cookie);

    if (!session) {
      return undefined;
    }

    if (Date.parse(session.expires_at) <= Date.now()) {
      await this.revokeSession(session.session_hash);
      return undefined;
    }

    const accessToken = this.decrypt(session.access_token_ciphertext);
    const user = await this.verifyAccessToken(accessToken);

    if (user?.id === session.user_id) {
      return user;
    }

    try {
      const refreshed = await this.refresh(cookie);
      if (refreshed.user.id === session.user_id) {
        return refreshed.user;
      }

      await this.revokeSession(session.session_hash);
      return undefined;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        return undefined;
      }

      throw error;
    }
  }

  async refresh(cookie: string): Promise<{ cookieMaxAgeMs: number; user: AuthenticatedUser }> {
    const hash = this.hashCookie(cookie);
    let session = await this.loadSession(cookie);

    if (!session) {
      throw new UnauthorizedException('Session expired');
    }

    if (Date.parse(session.expires_at) <= Date.now()) {
      await this.revokeSession(hash);
      throw new UnauthorizedException('Session expired');
    }

    const lockId = randomUUID();
    const claimed = await this.databaseRequest<boolean>('/rpc/claim_app_session_refresh', {
      method: 'POST',
      body: JSON.stringify({
        p_session_hash: hash,
        p_lock_id: lockId,
        p_lease_seconds: Math.ceil(REFRESH_LOCK_MS / 1000),
      }),
    });

    if (!claimed) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const latest = await this.loadSession(cookie);

        if (!latest) {
          throw new UnauthorizedException('Session expired');
        }

        if (Date.parse(latest.expires_at) <= Date.now()) {
          await this.revokeSession(hash);
          throw new UnauthorizedException('Session expired');
        }

        if (latest.user_id !== session.user_id) {
          await this.revokeSession(hash);
          throw new UnauthorizedException('Session identity changed during refresh');
        }

        if (latest.refresh_token_ciphertext !== session.refresh_token_ciphertext) {
          const user = await this.verifyAccessToken(this.decrypt(latest.access_token_ciphertext));

          if (user?.id === session.user_id) {
            return {
              cookieMaxAgeMs: Math.max(0, Date.parse(latest.expires_at) - Date.now()),
              user,
            };
          }

          if (user && user.id !== session.user_id) {
            await this.revokeSession(hash);
            throw new UnauthorizedException('Session identity changed during refresh');
          }
        }
      }

      throw new SessionRefreshInProgressException();
    }

    try {
      session = await this.loadSession(cookie);

      if (!session || session.refresh_lock_id !== lockId) {
        throw new UnauthorizedException('Session changed during refresh');
      }

      const refreshToken = this.decrypt(session.refresh_token_ciphertext);
      let tokens: SupabaseTokenResponse;

      try {
        // Keep the stored parent token until the rotated pair is durable. Supabase Auth
        // can return the active child when its parent is retried after a lost response.
        tokens = await this.authRequest<SupabaseTokenResponse>('/token?grant_type=refresh_token', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          await this.revokeSession(hash);
        }

        throw error;
      }

      if (tokens.user.id !== session.user_id) {
        throw new UnauthorizedException('Session identity changed during refresh');
      }
      const updated = await this.databaseRequest<AppSession[]>(
        `/app_sessions?session_hash=eq.${hash}&refresh_lock_id=eq.${lockId}&revoked_at=is.null`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            access_token_ciphertext: this.encrypt(tokens.access_token),
            refresh_token_ciphertext: this.encrypt(tokens.refresh_token),
            refresh_lock_id: null,
            refresh_lock_until: null,
            updated_at: new Date().toISOString(),
          }),
        },
      );

      if (!updated.length) {
        throw new UnauthorizedException('Session was revoked during refresh');
      }

      return {
        cookieMaxAgeMs: Math.max(0, Date.parse(session.expires_at) - Date.now()),
        user: { id: tokens.user.id, email: tokens.user.email || null },
      };
    } finally {
      await this.databaseRequest('/rpc/release_app_session_refresh', {
        method: 'POST',
        body: JSON.stringify({ p_session_hash: hash, p_lock_id: lockId }),
      }).catch(() => undefined);
    }
  }

  async logout(cookie: string): Promise<string | undefined> {
    const hash = this.hashCookie(cookie);
    const session = await this.loadSession(cookie);

    if (!session) {
      return undefined;
    }

    const accessToken = this.decrypt(session.access_token_ciphertext);

    await this.revokeSupabaseSession(accessToken);

    await this.revokeSession(hash);
    return hash;
  }

  async canJoinCourse(userId: string, courseId: string): Promise<boolean> {
    const result = await this.databaseRequest<boolean>('/rpc/can_user_join_course', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId, p_course_id: courseId }),
    });

    return result === true;
  }

  async markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
    const updated = await this.databaseRequest<Array<{ id: string }>>(
      `/notifications?id=eq.${notificationId}&user_id=eq.${userId}&read_at=is.null`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ read_at: new Date().toISOString() }),
      },
    );

    return updated.length > 0;
  }

  async getUnreadNotifications(userId: string): Promise<NotificationRecord[]> {
    return this.databaseRequest<NotificationRecord[]>(
      `/notifications?user_id=eq.${userId}&read_at=is.null&select=id,user_id,type,title,body,read_at,created_at&order=created_at.desc&limit=50`,
    );
  }

  async createClassroomMessage(userId: string, courseId: string, body: string) {
    const message = await this.databaseRequest<ClassroomMessage | null>('/rpc/create_classroom_message_if_member', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId, p_course_id: courseId, p_body: body }),
    });

    if (!message) {
      throw new ForbiddenException('Course membership is required to send messages');
    }

    return message;
  }

  async checkDatabaseReadiness(): Promise<boolean> {
    const rows = await this.databaseRequest<Array<{ schema_version: number }>>(
      '/api_schema_metadata?schema_version=eq.1&select=schema_version&limit=1',
    );

    return rows.length === 1;
  }

  async getCourseMessages(courseId: string, maximum = 50): Promise<ClassroomMessage[]> {
    const rows = await this.databaseRequest<ClassroomMessage[]>(
      `/classroom_messages?course_id=eq.${courseId}&select=id,course_id,sender_id,body,created_at&order=created_at.desc&limit=${maximum}`,
    );

    return rows.reverse();
  }

  async createNotification(userId: string, type: string, title: string, body: string): Promise<NotificationRecord> {
    const rows = await this.databaseRequest<NotificationRecord[]>('/notifications?select=id,user_id,type,title,body,read_at,created_at', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ user_id: userId, type, title, body }),
    });

    return rows[0];
  }

  async getDashboard(userId: string) {
    const [profiles, enrollments, certificates] = await Promise.all([
      this.databaseRequest<SupabaseProfile[]>(
        `/profiles?id=eq.${userId}&select=id,display_name,role&limit=1`,
      ),
      this.databaseRequest<EnrollmentRow[]>(
        `/course_enrollments?user_id=eq.${userId}&status=eq.active&select=course_id`,
      ),
      this.databaseRequest<Array<{ id: string }>>(`/certificates?user_id=eq.${userId}&select=id`),
    ]);
    const courseIds = enrollments.map(({ course_id }) => course_id);
    let courses: DatabaseCourse[] = [];
    let progress: ProgressRow[] = [];

    if (courseIds.length > 0) {
      [courses, progress] = await Promise.all([
          this.databaseRequest<DatabaseCourse[]>(
            `/courses?id=in.(${courseIds.join(',')})&status=eq.published&select=id,title,category,level,duration_minutes,lesson_count,accent,icon,description,instructor:profiles!courses_owner_id_fkey(display_name)`,
          ),
          this.databaseRequest<ProgressRow[]>(
            `/course_progress?user_id=eq.${userId}&course_id=in.(${courseIds.join(',')})&select=course_id,progress_percent,minutes_spent`,
          ),
        ]);
    }
    const progressByCourse = new Map(progress.map((row) => [row.course_id, row]));
    const profile = profiles[0];

    return {
      learner: {
        id: profile?.id || userId,
        displayName: profile?.display_name || '',
        role: profile?.role || 'learner',
      },
      stats: {
        hoursLearned: Math.round((progress.reduce((total, row) => total + row.minutes_spent, 0) / 60) * 10) / 10,
        coursesInProgress: courseIds.filter((id) => (progressByCourse.get(id)?.progress_percent || 0) < 100).length,
        certificates: certificates.length,
      },
      courses: courses.map((course) => ({
        id: course.id,
        title: course.title,
        instructor: course.instructor?.display_name || '',
        category: course.category,
        level: course.level,
        duration: course.duration_minutes >= 60
          ? `${Math.round(course.duration_minutes / 60)} hours`
          : `${course.duration_minutes} min`,
        lessons: course.lesson_count,
        progress: progressByCourse.get(course.id)?.progress_percent || 0,
        accent: course.accent,
        icon: course.icon,
        description: course.description,
      })),
    };
  }

  async findPublishedCourses(query?: string) {
    const courses = await this.databaseRequest<DatabaseCourse[]>(
      '/courses?status=eq.published&select=id,title,category,level,duration_minutes,lesson_count,accent,icon,description,instructor:profiles!courses_owner_id_fkey(display_name)&limit=100',
    );
    const normalizedQuery = query?.trim().toLowerCase();

    return courses
      .filter((course) => !normalizedQuery ||
        `${course.title} ${course.category} ${course.instructor?.display_name || ''}`.toLowerCase().includes(normalizedQuery))
      .map((course) => ({
        id: course.id,
        title: course.title,
        instructor: course.instructor?.display_name || '',
        category: course.category,
        level: course.level,
        duration: course.duration_minutes >= 60
          ? `${Math.round(course.duration_minutes / 60)} hours`
          : `${course.duration_minutes} min`,
        lessons: course.lesson_count,
        progress: 0,
        accent: course.accent,
        icon: course.icon,
        description: course.description,
      }));
  }
}
