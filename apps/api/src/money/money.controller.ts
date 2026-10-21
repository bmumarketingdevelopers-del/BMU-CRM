import { createHmac, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public } from '../common/decorators.js';
import { CapacityService } from './capacity.service.js';
import { CashflowService } from './cashflow.service.js';
import { ExpensesService } from './expenses.service.js';
import { PaymentsHubService, type RazorpayEvent } from './payments-hub.service.js';
import { ProfitService } from './profit.service.js';
import { SchedulesService } from './schedules.service.js';
import { TaskPassService } from './task-pass.service.js';
import { TimerService } from './timer.service.js';

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@Controller('money')
export class MoneyController {
  constructor(
    private readonly hub: PaymentsHubService,
    private readonly schedules: SchedulesService,
    private readonly expenses: ExpensesService,
    private readonly profitSvc: ProfitService,
    private readonly cash: CashflowService,
  ) {}

  @Get('options')
  options(@CurrentUser() me: Me) {
    return this.hub.options(me);
  }

  @Get('invoices/:id/links')
  links(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.hub.links(me, id);
  }

  @Post('invoices/:id/links')
  createLink(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.hub.createLink(me, id, me.orgId, ip);
  }

  @Post('links/:id/cancel')
  cancelLink(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.hub.cancelLink(me, id, ip);
  }

  @Get('unmatched')
  unmatched(@CurrentUser() me: Me) {
    return this.hub.unmatched(me);
  }

  @Post('unmatched')
  addUnmatched(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.hub.addUnmatched(me, body, ip);
  }

  @Post('unmatched/:id/match')
  match(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.hub.match(me, id, body, ip);
  }

  @Post('unmatched/:id/ignore')
  ignore(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.hub.ignore(me, id, ip);
  }

  @Get('schedules')
  schedulesList(@CurrentUser() me: Me, @Query('clientId') clientId?: string, @Query('engagementId') engagementId?: string, @Query('status') status?: string) {
    return this.schedules.list(me, { clientId, engagementId, status });
  }

  @Post('schedules')
  addSchedule(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.schedules.create(me, body, ip);
  }

  @Post('schedules/plan')
  planSchedule(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.schedules.plan(me, body, ip);
  }

  @Patch('schedules/:id')
  updateSchedule(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.schedules.update(me, id, body, ip);
  }

  @Post('schedules/:id/issue')
  issueSchedule(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.schedules.issueNow(me, id, ip);
  }

  @Get('expenses')
  expensesList(@CurrentUser() me: Me, @Query('kind') kind?: string, @Query('status') status?: string, @Query('mine') mine?: string) {
    return this.expenses.list(me, { kind, status, mine });
  }

  @Post('expenses')
  addExpense(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.expenses.create(me, body, ip);
  }

  @Post('expenses/rebill')
  rebill(@CurrentUser() me: Me, @Body() body: { clientOrgId?: string }, @ClientIp() ip?: string) {
    return this.expenses.rebill(me, String(body?.clientOrgId ?? ''), ip);
  }

  @Put('expenses/:id')
  updateExpense(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.expenses.update(me, id, body, ip);
  }

  @Post('expenses/:id/decide')
  decideExpense(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.expenses.decide(me, id, body, ip);
  }

  @Post('expenses/:id/paid')
  payExpense(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.expenses.markPaid(me, id, body, ip);
  }

  @Delete('expenses/:id')
  deleteExpense(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.expenses.remove(me, id, ip);
  }

  @Get('profit')
  profit(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string) {
    return this.profitSvc.profit(me, from, to);
  }

  @Get('cashflow')
  cashflow(@CurrentUser() me: Me) {
    return this.cash.forecast(me);
  }
}

@Controller('timer')
export class TimerController {
  constructor(private readonly timer: TimerService) {}

  @Get()
  get(@CurrentUser() me: Me) {
    return this.timer.get(me);
  }

  @Post('start')
  start(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.timer.start(me, body, ip);
  }

  @Post('stop')
  stop(@CurrentUser() me: Me, @ClientIp() ip?: string) {
    return this.timer.stop(me, ip);
  }

  @Post('discard')
  discard(@CurrentUser() me: Me) {
    return this.timer.discard(me);
  }
}

@Controller('capacity')
export class CapacityController {
  constructor(
    private readonly capacity: CapacityService,
    private readonly pass: TaskPassService,
  ) {}

  // v23 pass a task to a colleague in the same department (accept / decline / withdraw: /actions/approvals/:id/...)
  @Get('pass')
  passView(@CurrentUser() me: Me) {
    return this.pass.view(me);
  }

  @Get('pass/candidates')
  passCandidates(@CurrentUser() me: Me, @Query('taskId') taskId: string) {
    return this.pass.candidates(me, taskId);
  }

  @Post('pass')
  passTask(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.pass.request(me, body, ip);
  }

  @Get('workload')
  workload(@CurrentUser() me: Me, @Query('from') from?: string, @Query('weeks') weeks?: string, @Query('team') team?: string) {
    return this.capacity.workload(me, { from, weeks, team });
  }

  @Get('suggest')
  suggest(@CurrentUser() me: Me, @Query('weekStart') weekStart: string, @Query('specialty') specialty?: string, @Query('hours') hours?: string) {
    return this.capacity.suggest(me, { weekStart, specialty, hours });
  }

  @Post('bookings')
  book(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.capacity.book(me, body, ip);
  }

  @Patch('bookings/:id')
  update(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.capacity.update(me, id, body, ip);
  }

  @Delete('bookings/:id')
  remove(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.capacity.remove(me, id, ip);
  }

  @Get('projects/:id/bookings')
  project(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.capacity.projectBookings(me, id);
  }

  @Put('people/:id/hours')
  hours(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.capacity.setWeeklyHours(me, id, body, ip);
  }
}

/** Public pay page and Razorpay's webhook (no sign-in). */
@Controller()
export class PublicMoneyController {
  constructor(private readonly hub: PaymentsHubService) {}

  @Public()
  @Get('public/pay/:token')
  view(@Param('token') token: string) {
    return this.hub.publicView(token);
  }

  @Public()
  @Post('public/pay/:token/test')
  @HttpCode(200)
  test(@Param('token') token: string) {
    return this.hub.publicTest(token);
  }

  /** Razorpay → Settings → Webhooks: events payment.captured and payment_link.paid, secret = RAZORPAY_WEBHOOK_SECRET. */
  @Public()
  @Post('webhooks/razorpay')
  @HttpCode(200)
  async razorpay(@Req() req: Request & { rawBody?: Buffer }, @Body() body: RazorpayEvent, @Headers('x-razorpay-signature') signature?: string) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (secret) {
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      if (!signature || !safeEqual(signature, expected)) throw new UnauthorizedException('Bad signature');
    } else if (process.env.NODE_ENV === 'production' || process.env.RAZORPAY_KEY_SECRET) {
      // Without the webhook secret anyone could mark invoices paid, so only a dev server without keys accepts unsigned calls.
      throw new ForbiddenException('Set RAZORPAY_WEBHOOK_SECRET to receive Razorpay webhooks');
    }
    return this.hub.onRazorpay(body);
  }
}
