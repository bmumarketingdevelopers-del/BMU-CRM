import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  attendanceCorrectionSchema,
  branchInputSchema,
  branchUpdateSchema,
  decideLeaveSchema,
  departmentInputSchema,
  departmentUpdateSchema,
  engagementLifecycleSchema,
  moveMemberSchema,
  offboardingTickSchema,
  reassignAmSchema,
  teamInputSchema,
  teamUpdateSchema,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { AttendanceService } from './attendance.service.js';
import { ClientsAdminService } from './clients-admin.service.js';
import { StructureService } from './structure.service.js';

/** Command Centre: Organisation, Clients and Catalogue screens. Each service checks roles itself. */
@Controller('admin-org')
export class AdminOrgController {
  constructor(
    private readonly structure: StructureService,
    private readonly attendance: AttendanceService,
    private readonly clients: ClientsAdminService,
  ) {}

  // Organisation
  @Get('structure')
  view(@CurrentUser() me: Me) {
    return this.structure.view(me);
  }

  @Post('branches')
  createBranch(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.structure.createBranch(me, parse(branchInputSchema, body), ip);
  }

  @Patch('branches/:id')
  updateBranch(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.structure.updateBranch(me, id, parse(branchUpdateSchema, body), ip);
  }

  @Post('departments')
  createDepartment(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.structure.createDepartment(me, parse(departmentInputSchema, body), ip);
  }

  @Patch('departments/:id')
  updateDepartment(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.structure.updateDepartment(me, id, parse(departmentUpdateSchema, body), ip);
  }

  @Delete('departments/:id')
  deleteDepartment(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.structure.deleteDepartment(me, id, ip);
  }

  @Post('teams')
  createTeam(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.structure.createTeam(me, parse(teamInputSchema, body), ip);
  }

  @Patch('teams/:id')
  updateTeam(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.structure.updateTeam(me, id, parse(teamUpdateSchema, body), ip);
  }

  @Delete('teams/:id')
  deleteTeam(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.structure.deleteTeam(me, id, ip);
  }

  @Post('members/move')
  moveMember(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.structure.moveMember(me, parse(moveMemberSchema, body), ip);
  }

  // Attendance & leave
  @Get('attendance')
  attendanceView(@CurrentUser() me: Me, @Query('month') month?: string) {
    return this.attendance.view(me, month);
  }

  // v30: today by department, the records sheet, and attendance corrections.
  @Get('attendance/today')
  attendanceToday(@CurrentUser() me: Me) {
    return this.attendance.today(me);
  }

  @Get('attendance/records')
  attendanceRecords(@CurrentUser() me: Me, @Query('from') from?: string, @Query('to') to?: string, @Query('departmentId') departmentId?: string) {
    return this.attendance.records(me, { from, to, departmentId });
  }

  @Get('attendance/corrections/mine')
  myCorrections(@CurrentUser() me: Me) {
    return this.attendance.myCorrections(me);
  }

  @Get('attendance/corrections')
  corrections(@CurrentUser() me: Me) {
    return this.attendance.corrections(me);
  }

  @Post('attendance/corrections')
  requestCorrection(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.attendance.requestCorrection(me, parse(attendanceCorrectionSchema, body), ip);
  }

  @Post('attendance/corrections/:id/cancel')
  cancelCorrection(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.attendance.cancelCorrection(me, id, ip);
  }

  @Post('attendance/corrections/:id/decide')
  decideCorrection(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.attendance.decideCorrection(me, id, parse(decideLeaveSchema, body), ip);
  }

  @Get('leave')
  leave(@CurrentUser() me: Me) {
    return this.attendance.leave(me);
  }

  @Post('leave/:id/decide')
  decideLeave(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.attendance.decide(me, id, parse(decideLeaveSchema, body), ip);
  }

  // Clients
  @Get('engagements')
  engagements(@CurrentUser() me: Me) {
    return this.clients.engagements(me);
  }

  @Get('am-workload')
  workload(@CurrentUser() me: Me) {
    return this.clients.workload(me);
  }

  @Post('clients/:id/am')
  reassign(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.clients.reassignAm(me, id, parse(reassignAmSchema, body).amUserId, ip);
  }

  @Get('offboarding')
  offboarding(@CurrentUser() me: Me) {
    return this.clients.offboarding(me);
  }

  @Post('engagements/:id/lifecycle')
  lifecycle(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.clients.lifecycle(me, id, parse(engagementLifecycleSchema, body), ip);
  }

  @Post('engagements/:id/offboarding-checklist')
  tick(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { key, done } = parse(offboardingTickSchema, body);
    return this.clients.tick(me, id, key, done, ip);
  }

  // Catalogue
  @Get('discount-approvals')
  discountApprovals(@CurrentUser() me: Me) {
    return this.clients.discountApprovals(me);
  }
}
