const crypto = require('crypto');
const userRepository = require('../repositories/user.repository');
const teamRepository = require('../repositories/team.repository');
const teamService = require('./team.service');
const notificationService = require('./notification.service');
const activityService = require('./activity.service');
const policy = require('./policy.service');
const ApiError = require('../utils/ApiError.util');
const {
  ROLE_VALUES,
  ROLES,
  ROLE_RANK,
  isRoleAllowedForDepartment,
  getAllowedRolesForDepartment,
  getDefaultJobTitle,
  getInviteRoleLabel,
  normalizeDepartmentCode,
  normalizeRole,
} = require('../constants/roles.constant');
const { PERMISSIONS, getInvitableRoles } = require('../constants/permissions.constant');
const { publicActorLabel } = require('../utils/publicActor.util');
const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
const { notifySuperAdmins } = require('./notifySuperAdmins.util');
const { sendMail } = require('../emails/mailer.util');
const { inviteEmail } = require('../emails/templates');
const env = require('../config/env');
const logger = require('../config/logger');
const { getEmailAppUrl } = require('../utils/clientUrl.util');
const User = require('../models/user.model');
const Department = require('../models/department.model');
const Project = require('../models/project.model');
const { emitUserEvent, forceDisconnectUser } = require('../socket/socket');

/** Invite accept links stay valid long enough to open webmail and register. */
const INVITE_TOKEN_TTL_MINUTES = 24 * 60; // 24 hours

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function createInviteToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hashed: hashToken(raw) };
}

function inviteTtlMinutes() {
  return INVITE_TOKEN_TTL_MINUTES;
}

function formatInviteTtlLabel(minutes) {
  const mins = Number(minutes) || INVITE_TOKEN_TTL_MINUTES;
  if (mins >= 1440) {
    const days = Math.round(mins / 1440);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (mins >= 60) {
    const hours = Math.round(mins / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

function inviteExpiryDate(from = Date.now()) {
  return new Date(from + inviteTtlMinutes() * 60 * 1000);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findOrCreateDepartmentByName(name, actor) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2) {
    throw ApiError.badRequest('Department name must be at least 2 characters');
  }

  const existing = await Department.findOne({
    name: { $regex: `^${escapeRegex(trimmed)}$`, $options: 'i' },
  });
  if (existing) {
    if (!existing.isActive) {
      existing.isActive = true;
      await existing.save();
    }
    return existing;
  }

  if (actor.role !== ROLES.SUPER_ADMIN) {
    policy.assertPermission(actor, PERMISSIONS.DEPARTMENT_MANAGE);
  }

  let code = normalizeDepartmentCode(trimmed);
  if (!code || code.length < 2) {
    code = `dept_${Date.now().toString(36)}`;
  }
  const codeTaken = await Department.findOne({ code });
  if (codeTaken) {
    code = `${code}_${Date.now().toString(36).slice(-4)}`;
  }

  return Department.create({
    name: trimmed,
    code,
    description: `Custom department: ${trimmed}`,
    isActive: true,
  });
}

async function findOrCreateTeamByName(name, departmentId, actor) {
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2) {
    throw ApiError.badRequest('Team name must be at least 2 characters');
  }

  const Team = require('../models/team.model');
  const existing = await Team.findOne({
    department: departmentId,
    name: { $regex: `^${escapeRegex(trimmed)}$`, $options: 'i' },
  });
  if (existing) return existing;

  if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.ADMIN) {
    throw ApiError.forbidden('Only Superadmin or Admin can create a team while inviting');
  }

  return Team.create({
    name: trimmed,
    department: departmentId,
    members: [actor.id],
    lead: actor.id,
  });
}

class UserService {
  async list(actor, { page, limit, q, department, role, includeInactive }) {
    policy.assertPermission(actor, PERMISSIONS.USER_VIEW);

    let filter = policy.userListFilter(actor);
    // All People never shows soft-deleted / inactive accounts unless SA explicitly asks
    if (includeInactive === 'all' && actor.role === ROLES.SUPER_ADMIN) {
      const { isActive: _ia, ...rest } = filter;
      filter = rest;
    } else {
      filter = {
        ...filter,
        isActive: true,
        email: { $not: { $regex: '^deleted_', $options: 'i' } },
      };
    }

    if (q) {
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { name: { $regex: q, $options: 'i' } },
            { email: { $regex: q, $options: 'i' } },
            { jobTitle: { $regex: q, $options: 'i' } },
          ],
        },
      ];
    }
    if (department) filter.department = department;
    if (role) filter.role = role;

    return userRepository.findPaginated(filter, { page, limit });
  }

  async me(userId) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.notFound('User not found');
    const safe = user.toSafeObject();
    const context = await policy.buildActorContext(userId);
    return {
      ...safe,
      permissions: context.permissions,
      headedDepartmentIds: context.headedDepartmentIds,
      ledTeamIds: context.ledTeamIds,
      teamIds: context.teamIds,
    };
  }

  async getById(actor, id) {
    policy.assertPermission(actor, PERMISSIONS.USER_VIEW);
    const user = await userRepository.findById(id);
    if (!user) throw ApiError.notFound('User not found');

    const targetDept = user.department ? String(user.department) : null;
    const deptAccess = targetDept
      ? policy.getDepartmentAccess(actor, targetDept)
      : actor.role === ROLES.SUPER_ADMIN
        ? 'manage'
        : 'none';

    if (deptAccess === 'none' && String(user._id) !== actor.id) {
      throw ApiError.forbidden('You cannot view this user');
    }
    return user.toSafeObject();
  }

  async updateMe(userId, { name, jobTitle, avatarUrl }) {
    const user = await userRepository.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (jobTitle !== undefined) updates.jobTitle = jobTitle || null;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl || null;

    const updated = await userRepository.updateById(userId, updates);
    return updated.toSafeObject();
  }

  async changePassword(userId, { currentPassword, newPassword }) {
    const user = await userRepository.findById(userId, { withPassword: true });
    if (!user) throw ApiError.notFound('User not found');

    if (!user.password) {
      throw ApiError.badRequest(
        'This account has no password. Use forgot password or Google Sign-In settings.'
      );
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      throw ApiError.badRequest('Current password is incorrect');
    }

    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return { message: 'Password updated successfully' };
  }

  /**
   * Super Admin / scoped invite with Department → Role → Team → Team Lead.
   */
  async invite(payload, actor) {
    policy.assertPermission(actor, PERMISSIONS.USER_INVITE);

    const {
      email,
      name,
      role: rawRole = ROLES.MEMBER,
      jobTitle,
      department,
      departmentName,
      team,
      teamName,
      teamLead,
      setAsTeamLead = false,
    } = payload;

    const role = normalizeRole(rawRole);

    const normalizedEmail = email.trim().toLowerCase();

    // Remove leftover soft-deleted clones so invite creates a clean Google-only user
    await userRepository.purgeSoftDeletedForEmail(normalizedEmail);

    const existingUser = await userRepository.findByEmailInsensitiveWithInvite(normalizedEmail, {
      withPassword: true,
    });

    const hasJoined =
      Boolean(existingUser) &&
      existingUser.isActive !== false &&
      existingUser.invitePending !== true &&
      Boolean(existingUser.lastLoginAt);

    if (existingUser && hasJoined) {
      throw ApiError.conflict(
        'This email already belongs to an active workspace member. Edit their role in Teams instead of inviting again.'
      );
    }

    // Re-send invite only for pending / inactive / never-finished onboarding
    const canReinvite =
      Boolean(existingUser) &&
      (existingUser.invitePending === true ||
        existingUser.isActive === false ||
        !existingUser.lastLoginAt);

    if (existingUser && !canReinvite) {
      throw ApiError.conflict(
        'This email is already registered. Please log in using your existing account.'
      );
    }
    const isReinvite = Boolean(existingUser && canReinvite);

    if (!ROLE_VALUES.includes(role)) {
      throw ApiError.badRequest('Invalid role');
    }
    // Only Super Admin may grant Super Admin access
    if (role === ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only Super Admin can invite another Super Admin');
    }
    if (!policy.canInviteRole(actor, role)) {
      throw ApiError.forbidden(
        `You cannot invite users with role "${role}". Allowed: ${getInvitableRoles(actor.role).join(', ') || 'none'}`
      );
    }

    let resolvedDepartment = department || null;
    let teamDoc = null;
    let departmentDoc = null;

    // Typed department name → find or create
    if (!resolvedDepartment && departmentName) {
      departmentDoc = await findOrCreateDepartmentByName(departmentName, actor);
      resolvedDepartment = departmentDoc._id;
    }

    if (team) {
      teamDoc = await teamRepository.findById(team);
      if (!teamDoc) throw ApiError.notFound('Team not found');
      resolvedDepartment =
        teamDoc.department?.toString?.() || teamDoc.department || resolvedDepartment;

      // Scope: team leads can only invite into teams they lead
      if (actor.role === ROLES.TEAM_LEAD) {
        policy.assertTeamManage(actor, teamDoc);
      }
      if (actor.role === ROLES.DEPT_HEAD) {
        policy.assertDepartmentManage(
          actor,
          resolvedDepartment,
          'invite into teams outside your department'
        );
      }
    } else if (teamName && resolvedDepartment) {
      teamDoc = await findOrCreateTeamByName(teamName, resolvedDepartment, actor);
      // continue as if team was selected
    } else if (resolvedDepartment) {
      if (actor.role === ROLES.DEPT_HEAD) {
        policy.assertDepartmentManage(
          actor,
          resolvedDepartment,
          'invite into another department'
        );
      }
      if (actor.role === ROLES.TEAM_LEAD) {
        throw ApiError.forbidden('Team leads must invite into one of their teams');
      }
    } else if (actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.badRequest('Department or team is required — select one or type a name');
    }

    // Super Admin invitees do not require a department
    if (
      actor.role === ROLES.SUPER_ADMIN &&
      role !== ROLES.SUPER_ADMIN &&
      !resolvedDepartment &&
      !departmentName
    ) {
      throw ApiError.badRequest('Select a department so you can assign the correct role');
    }

    if (resolvedDepartment && role !== ROLES.SUPER_ADMIN) {
      departmentDoc = departmentDoc || (await Department.findById(resolvedDepartment));
      if (!departmentDoc) throw ApiError.notFound('Department not found');

      if (!isRoleAllowedForDepartment(departmentDoc.code, role)) {
        const allowed = getAllowedRolesForDepartment(departmentDoc.code)
          .map((r) => getInviteRoleLabel(departmentDoc.code, r))
          .join(', ');
        throw ApiError.badRequest(
          `Role "${getInviteRoleLabel(departmentDoc.code, role)}" is not allowed in ${departmentDoc.name}. Allowed: ${allowed}`
        );
      }
    }

    const resolvedTeamId = team || (teamDoc?._id ? String(teamDoc._id) : null);

    // Optional: validate selected team lead belongs to the team/department
    if (teamLead && teamDoc) {
      const leadId = String(teamDoc.lead?._id || teamDoc.lead);
      if (leadId !== String(teamLead) && actor.role === ROLES.SUPER_ADMIN) {
        // Allow SA to reassign lead when inviting a team_lead
        if (role === ROLES.TEAM_LEAD && setAsTeamLead) {
          // will set below
        } else {
          const candidate = await userRepository.findById(teamLead);
          if (!candidate || candidate.role !== ROLES.TEAM_LEAD) {
            throw ApiError.badRequest('Selected team lead is invalid');
          }
        }
      }
    }

    const displayName =
      (name && name.trim()) ||
      normalizedEmail.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    // All new invites use password registration (Complete registration form).
    // Existing logged-in Google users are not touched — only pending/re-invites.
    const isLocalInvite = true;
    const inviteAuthProvider = 'local';
    const ttlMinutes = inviteTtlMinutes();

    const { raw: inviteRaw, hashed: inviteHashed } = createInviteToken();
    const inviteExpires = inviteExpiryDate();

    const inviter = await userRepository.findById(actor.id);
    const resolvedJobTitle =
      (jobTitle && String(jobTitle).trim()) ||
      (role === ROLES.SUPER_ADMIN ? 'Super Admin' : null) ||
      getDefaultJobTitle(departmentDoc?.code, role) ||
      undefined;

    /** Re-apply invite fields (Google or local/password) without wiping role trust. */
    const applyInviteFields = async (doc) => {
      const UserModel = require('../models/user.model');
      const $unset = {
        passwordResetToken: 1,
        passwordResetExpires: 1,
      };
      if (inviteAuthProvider === 'google') {
        $unset.password = 1;
        $unset.googleId = 1;
      } else {
        // Local invite: clear any prior Google link / password until they set one
        $unset.googleId = 1;
        $unset.password = 1;
      }
      await UserModel.updateOne(
        { _id: doc._id },
        {
          $set: {
            name: displayName,
            role: role || ROLES.MEMBER,
            jobTitle: resolvedJobTitle || doc.jobTitle || null,
            department: resolvedDepartment,
            invitePending: true,
            invitedBy: actor.id,
            inviteToken: inviteHashed,
            inviteTokenExpires: inviteExpires,
            isActive: true,
            authProvider: inviteAuthProvider,
            deactivatedAt: null,
            lastLoginAt: null,
          },
          $unset,
        }
      );
      return UserModel.findById(doc._id).select('+inviteToken +inviteTokenExpires');
    };

    let user;
    if (isReinvite) {
      user = await applyInviteFields(existingUser);
    } else {
      try {
        user = await userRepository.create({
          name: displayName,
          email: normalizedEmail,
          authProvider: inviteAuthProvider,
          role: role || ROLES.MEMBER,
          jobTitle: resolvedJobTitle || null,
          department: resolvedDepartment,
          invitePending: true,
          invitedBy: actor.id,
          inviteToken: inviteHashed,
          inviteTokenExpires: inviteExpires,
          isActive: true,
        });
      } catch (createErr) {
        // Race or duplicate from a prior failed live invite — load and re-send
        if (createErr?.code === 11000) {
          const dup = await userRepository.findByEmailInsensitiveWithInvite(normalizedEmail, {
            withPassword: true,
          });
          const dupHasJoined =
            dup &&
            dup.isActive !== false &&
            dup.invitePending !== true &&
            Boolean(dup.lastLoginAt);
          const dupCanReinvite =
            dup &&
            !dupHasJoined &&
            (dup.invitePending === true ||
              dup.isActive === false ||
              !dup.lastLoginAt);
          if (dup && dupCanReinvite) {
            user = await applyInviteFields(dup);
          } else {
            throw ApiError.conflict('A user with this email already exists');
          }
        } else {
          throw createErr;
        }
      }
    }

    if (!user) {
      throw ApiError.internal('Failed to create invite user');
    }

    if (resolvedTeamId) {
      try {
        await teamService.addMember(resolvedTeamId, user._id, actor.id);
      } catch (err) {
        // Already on team from a prior failed invite — ignore duplicate
        if (!/already|exists|duplicate/i.test(err.message || '')) throw err;
      }

      if (
        (role === ROLES.TEAM_LEAD && setAsTeamLead) ||
        (role === ROLES.TEAM_LEAD && !teamDoc?.lead)
      ) {
        await teamRepository.updateById(resolvedTeamId, { lead: user._id });
      }
    }

    if (role === ROLES.DEPT_HEAD && resolvedDepartment) {
      await Department.findByIdAndUpdate(resolvedDepartment, { head: user._id });
    }

    await Project.updateMany(
      { isPrivate: { $ne: true } },
      { $addToSet: { members: user._id } }
    );

    const clientBase = getEmailAppUrl();
    // Live + local: /register?token=… → Complete registration (password form).
    // Keep /accept-invite as an alias; email CTA uses /register so it matches local.
    const acceptUrl = `${clientBase}/register?token=${inviteRaw}`;
    const loginUrl = `${clientBase}/login`;
    const inviterLabel = publicActorLabel(inviter, 'BIWORKSPACE');
    const roleLabel = getInviteRoleLabel(departmentDoc?.code, role);
    const inviteMode = isLocalInvite ? 'password' : 'google';
    const emailPayload = {
      to: normalizedEmail,
      recipientName: displayName,
      inviterName: inviterLabel,
      loginUrl,
      acceptUrl,
      emailTo: normalizedEmail,
      inviteMode,
      expiresInMinutes: ttlMinutes,
      roleLabel,
    };

    // Prefer official BIWORKSPACE sender — Resend uses noreply@bicomworkspace.com when verified
    let emailFrom = env.EMAIL_FROM || 'BIWORKSPACE <noreply@bicomworkspace.com>';
    if (/houseofchilli\.pk|tasksmtp@bicommunications\.ae/i.test(String(emailFrom))) {
      emailFrom = 'BIWORKSPACE <noreply@bicomworkspace.com>';
    }

    const mailText = isLocalInvite
      ? [
          `BIWORKSPACE invitation`,
          ``,
          `Hi ${displayName},`,
          `${inviterLabel} invited you to join the BIWORKSPACE workspace as ${roleLabel}.`,
          ``,
          `Open this link to accept and set your password:`,
          acceptUrl,
          ``,
          `After that, sign in at: ${loginUrl}`,
          `Sign-in email: ${normalizedEmail}`,
          ``,
          `This invitation link expires in ${formatInviteTtlLabel(ttlMinutes)}.`,
          `If you did not expect this message, you can ignore it.`,
        ].join('\n')
      : [
          `BIWORKSPACE invitation`,
          ``,
          `Hi ${displayName},`,
          `${inviterLabel} invited you to join the BIWORKSPACE workspace as ${roleLabel}.`,
          ``,
          `Open this link to accept and continue with Google:`,
          acceptUrl,
          ``,
          `Use Google account: ${normalizedEmail}`,
          `Or sign in at: ${loginUrl}`,
          ``,
          `This invitation link expires in ${formatInviteTtlLabel(ttlMinutes)}.`,
          `If you did not expect this message, you can ignore it.`,
        ].join('\n');

    const inviteRefId = `invite-${String(user._id)}-${Date.now()}`;
    const mailPayload = {
      to: normalizedEmail,
      subject: `BIWORKSPACE invitation for ${normalizedEmail}`,
      html: inviteEmail(emailPayload),
      text: mailText,
      // Transactional headers + tags help inbox placement (not marketing)
      category: 'transactional',
      tags: ['invite', isLocalInvite ? 'password-invite' : 'google-invite'],
      headers: {
        'X-Entity-Ref-ID': inviteRefId,
        'X-BIWORKSPACE-Mail-Type': 'invitation',
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
      },
    };

    // Await Resend briefly (HTTPS works on Render). Never fail the invite if email fails —
    // user + accept link are already created so a second click can re-send.
    let emailDelivered = false;
    let emailError = null;
    let emailRedirectedTo = null;
    let mailResult = null;
    let via = 'none';

    try {
      mailResult = await Promise.race([
        sendMail(mailPayload),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Email send timed out after 12s')), 12_000)
        ),
      ]);
      emailDelivered = Boolean(
        mailResult &&
          !mailResult.logged &&
          !mailResult.redirected &&
          !mailResult.emailRedirectedTo
      );
      via = mailResult?.provider || 'unknown';
      emailRedirectedTo = mailResult?.emailRedirectedTo || mailResult?.redirectedTo || null;
      if (mailResult?.from) emailFrom = mailResult.from;
      if (mailResult?.logged) {
        emailError = 'Email provider is not configured on this server';
        emailDelivered = false;
      }
      if (emailRedirectedTo) {
        emailDelivered = false;
        emailError = `Provider would not send to ${normalizedEmail}`;
      }
    } catch (err) {
      emailError = err.message || 'Email delivery failed';
      logger.error(`Invite email failed for ${normalizedEmail}: ${emailError}`);
      // Still fire-and-forget a background retry (does not block response)
      sendMail(mailPayload).catch((retryErr) => {
        logger.error(`Invite email retry failed for ${normalizedEmail}: ${retryErr.message}`);
      });
    }

    const emailNote = emailDelivered
      ? isReinvite
        ? `Invitation email re-sent to ${normalizedEmail}. Ask them to check inbox and spam.`
        : `Invitation email sent to ${normalizedEmail}. Ask them to check inbox and spam.`
      : `Invite created for ${normalizedEmail}, but the email was not delivered${emailError ? ` (${emailError})` : ''}. Share the invite link below.`;


    await notificationService
      .notify({
        recipient: user._id,
        sender: actor.id,
        type: NOTIFICATION_TYPES.USER_INVITED,
        message: resolvedTeamId
          ? `${inviter?.name || 'Admin'} invited you and added you to a team`
          : `${inviter?.name || 'Admin'} invited you to the workspace`,
        entityType: 'User',
        entityId: user._id,
      })
      .catch(() => {});

    await notifySuperAdmins({
      actorId: actor.id,
      type: NOTIFICATION_TYPES.USER_INVITED,
      message: `${inviter?.name || 'Someone'} invited ${name} (${normalizedEmail}) as ${role}`,
      entityType: 'User',
      entityId: user._id,
      emailSubject: `User invited: ${name}`,
      emailToo: false,
    });

    await activityService
      .record({
        actor: actor.id,
        action: 'user_invited',
        entityType: 'User',
        entityId: user._id,
        metadata: { email: normalizedEmail, role, department: resolvedDepartment, team: resolvedTeamId },
      })
      .catch(() => {});

    const fresh = await userRepository.findById(user._id);
    try {
      emitUserEvent('user:created', fresh.toSafeObject());
    } catch {
      /* socket may not be ready in tests */
    }

    return {
      user: fresh.toSafeObject(),
      inviteToken: inviteRaw,
      acceptUrl,
      expiresAt: inviteExpires.toISOString(),
      expiresInMinutes: ttlMinutes,
      inviteMode,
      authProvider: inviteAuthProvider,
      emailSent: emailDelivered,
      emailError,
      emailTo: normalizedEmail,
      emailFrom,
      emailProvider: via,
      emailMessageId: mailResult?.messageId || null,
      emailRedirectedTo,
      emailNote,
      emailDeliveryStatus: mailResult?.deliveryStatus || null,
      teamId: resolvedTeamId || null,
      loginUrl,
      shareMessage: isLocalInvite
        ? [
            `You're invited to BIWORKSPACE by ${inviter?.name || 'a teammate'}.`,
            `Accept invitation & set password: ${acceptUrl}`,
            `Then sign in at: ${loginUrl}`,
            `Email: ${normalizedEmail}`,
            `This invite link expires in ${formatInviteTtlLabel(ttlMinutes)}.`,
          ].join('\n')
        : [
            `You're invited to BIWORKSPACE by ${inviter?.name || 'a teammate'}.`,
            `Accept invite & sign in with Google: ${acceptUrl}`,
            `Or login → Continue with Google: ${loginUrl}`,
            `Google email must be: ${normalizedEmail}`,
            `This invite link expires in ${formatInviteTtlLabel(ttlMinutes)}.`,
          ].join('\n'),
    };
  }

  /**
   * Accept invite by setting a password. Role always comes from the invite row in DB.
   * Does not migrate existing logged-in Google users — only pending invitees.
   */
  async acceptInvite({ token, password }) {
    const raw = String(token || '').trim();
    if (!raw) {
      throw ApiError.badRequest('Invite token is required');
    }

    const hashed = hashToken(raw);
    const user = await User.findOne({
      inviteToken: hashed,
      inviteTokenExpires: { $gt: new Date() },
    }).select('+inviteToken +inviteTokenExpires +password');

    if (!user) {
      throw ApiError.badRequest('Invite link is invalid or has expired');
    }

    if (!user.invitePending) {
      throw ApiError.badRequest('This invite was already accepted. Please sign in.');
    }

    const email = String(user.email || '')
      .trim()
      .toLowerCase();

    // Role is already on the user document from invite — never take it from the client
    user.password = password;
    user.authProvider = 'local';
    user.invitePending = false;
    user.isActive = true;
    user.deactivatedAt = null;
    await user.save();

    await User.updateOne(
      { _id: user._id },
      {
        $unset: {
          inviteToken: 1,
          inviteTokenExpires: 1,
          googleId: 1,
          passwordResetToken: 1,
          passwordResetExpires: 1,
        },
      }
    );

    const fresh = await User.findById(user._id);
    logger.info(`Invite accepted via password for ${email} role=${fresh?.role}`);
    return fresh.toSafeObject();
  }

  async previewInvite(token) {
    const hashed = hashToken(token);
    const user = await User.findOne({
      inviteToken: hashed,
      inviteTokenExpires: { $gt: new Date() },
    })
      .select(
        'name email role jobTitle invitePending department googleId inviteTokenExpires authProvider'
      )
      .populate('department', 'name code')
      .lean();

    if (!user) {
      // Token missing/expired — never push Google. Tell them to request a fresh invite.
      const stale = await User.findOne({ inviteToken: hashed })
        .select('email invitePending authProvider')
        .lean();
      if (stale) {
        throw ApiError.badRequest(
          'This invite link has expired. Ask your Superadmin to send a new invitation, then open the new link to set your password.'
        );
      }
      throw ApiError.badRequest(
        'Invite link is invalid or has expired. Ask your Superadmin for a new invite link.'
      );
    }

    const email = String(user.email || '')
      .trim()
      .toLowerCase();
    const alreadyAccepted =
      user.invitePending === false && (user.googleId || user.authProvider === 'local');
    if (alreadyAccepted) {
      throw ApiError.badRequest(
        user.authProvider === 'google' || user.googleId
          ? 'This invite was already accepted. Sign in with Google instead.'
          : 'This invite was already accepted. Please sign in with your email and password.'
      );
    }

    // New invites always complete registration with password (do not alter already-joined users)
    await User.updateOne(
      { _id: user._id },
      {
        $set: { authProvider: 'local' },
        $unset: { googleId: 1 },
      }
    );

    const { googleId: _g, inviteTokenExpires, ...safe } = user;
    const ttlMinutes = inviteTtlMinutes();

    return {
      ...safe,
      email,
      authProvider: 'local',
      inviteMode: 'password',
      expiresAt: inviteTokenExpires ? new Date(inviteTokenExpires).toISOString() : null,
      expiresInMinutes: ttlMinutes,
    };
  }

  /**
   * Super Admin (or scoped manager) updates user role/department/active.
   */
  async updateUser(actor, id, updates) {
    policy.assertPermission(actor, PERMISSIONS.USER_MANAGE);

    const target = await userRepository.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    if (actor.role !== ROLES.SUPER_ADMIN && !policy.canManageUser(actor, target)) {
      throw ApiError.forbidden('You cannot manage this user');
    }

    const allowed = {};
    if (updates.name !== undefined) allowed.name = updates.name;
    if (updates.jobTitle !== undefined) allowed.jobTitle = updates.jobTitle || null;

    if (updates.role !== undefined) {
      if (!ROLE_VALUES.includes(updates.role) || updates.role === ROLES.SUPER_ADMIN) {
        throw ApiError.badRequest('Invalid role');
      }
      if (
        actor.role !== ROLES.SUPER_ADMIN &&
        (ROLE_RANK[updates.role] || 0) >= (ROLE_RANK[actor.role] || 0)
      ) {
        throw ApiError.forbidden('Cannot assign a role equal or higher than your own');
      }
      allowed.role = updates.role;
    }

    if (updates.department !== undefined) {
      if (actor.role !== ROLES.SUPER_ADMIN) {
        policy.assertDepartmentManage(actor, updates.department, 'move users to this department');
      }
      allowed.department = updates.department || null;
    }

    if (updates.isActive !== undefined) {
      if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.DEPT_HEAD) {
        throw ApiError.forbidden('Only Super Admin or Department Head can deactivate users');
      }
      allowed.isActive = Boolean(updates.isActive);
      allowed.deactivatedAt = updates.isActive ? null : new Date();
      if (!updates.isActive) {
        allowed.tokenVersion = (target.tokenVersion || 0) + 1;
      }
    }

    const updated = await userRepository.updateById(id, allowed);

    if (updates.team) {
      await teamService.addMember(updates.team, id, actor.id);
    }

    await activityService
      .record({
        actor: actor.id,
        action: 'user_updated',
        entityType: 'User',
        entityId: id,
        metadata: { fields: Object.keys(allowed) },
      })
      .catch(() => {});

    const safe = updated.toSafeObject();
    emitUserEvent('user:updated', safe);

    if (updates.isActive === false) {
      forceDisconnectUser(id, {
        reason: 'deactivated',
        name: target.name,
        message: 'Your account has been deactivated. Please contact your administrator.',
      });
      await notifySuperAdmins({
        actorId: actor.id,
        type: NOTIFICATION_TYPES.USER_DEACTIVATED,
        message: `User "${target.name}" was deactivated`,
        entityType: 'User',
        entityId: id,
        emailSubject: `User deactivated: ${target.name}`,
        emailToo: false,
      });
    }

    return safe;
  }

  async deactivate(actor, id) {
    const updated = await this.updateUser(actor, id, { isActive: false });
    // Inactive accounts must leave live assignments / chat directories immediately.
    await this.#detachUserFromWorkspace(id, actor.id || actor._id, { deactivateConversations: true });
    return updated;
  }

  async reactivate(actor, id) {
    return this.updateUser(actor, id, { isActive: true });
  }

  /**
   * Pull a user out of teams, projects, tasks, meetings, and chat so they no
   * longer appear as an assignee, member, or chat contact.
   */
  async #detachUserFromWorkspace(userId, actorId, { deactivateConversations = true } = {}) {
    const Team = require('../models/team.model');
    const Project = require('../models/project.model');
    const Task = require('../models/task.model');
    const Department = require('../models/department.model');
    const Notification = require('../models/notification.model');
    const Conversation = require('../models/conversation.model');
    const Meeting = require('../models/meeting.model');
    const Comment = require('../models/comment.model');

    const uid = userId;

    await Promise.all([
      Team.updateMany({ members: uid }, { $pull: { members: uid } }),
      Team.updateMany({ lead: uid }, { $set: { lead: actorId } }),
      Project.updateMany({ members: uid }, { $pull: { members: uid } }),
      Project.updateMany({ developer: uid }, { $set: { developer: null } }),
      Project.updateMany({ owner: uid }, { $set: { owner: actorId } }),
      Task.updateMany({ assignees: uid }, { $pull: { assignees: uid } }),
      Department.updateMany({ head: uid }, { $set: { head: null } }),
      Meeting.updateMany({ attendees: uid }, { $pull: { attendees: uid } }),
      Comment.updateMany({ mentions: uid }, { $pull: { mentions: uid } }),
      Notification.deleteMany({ recipient: uid }),
      Conversation.updateMany(
        { participants: uid },
        { $pull: { participants: uid, readState: { user: uid } } }
      ),
    ]);

    if (deactivateConversations) {
      // 1:1 DMs with a removed member must disappear from chat lists.
      await Conversation.updateMany(
        { type: 'dm', participants: { $size: 1 } },
        { $set: { isActive: false } }
      );
      await Conversation.updateMany(
        { type: 'dm', participants: { $size: 0 } },
        { $set: { isActive: false } }
      );
    }
  }

  /**
   * Hard-delete Admin/Member: remove the user document and detach refs.
   * Re-inviting the same email creates a fresh invitePending user who must
   * accept again with Google (no leftover googleId / password).
   */
  async deleteUser(actor, id) {
    policy.assertPermission(actor, PERMISSIONS.USER_MANAGE);
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only Super Admin can delete users');
    }
    if (String(id) === String(actor.id)) {
      throw ApiError.badRequest('Cannot delete your own account');
    }

    const target = await userRepository.findById(id);
    if (!target) throw ApiError.notFound('User not found');

    if (target.role === ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Cannot delete a Super Admin');
    }

    const displayName = target.name;
    const originalEmail = String(target.email || '').toLowerCase().trim();
    const userId = target._id;
    const actorId = actor.id || actor._id;

    await this.#detachUserFromWorkspace(userId, actorId, { deactivateConversations: true });

    await userRepository.deleteById(userId);

    // Clean any historical soft-delete clones for this email
    if (originalEmail) {
      await userRepository.purgeSoftDeletedForEmail(originalEmail);
    }

    await activityService
      .record({
        actor: actorId,
        action: 'user_deleted',
        entityType: 'User',
        entityId: userId,
        metadata: { email: originalEmail, name: displayName, hardDelete: true },
      })
      .catch(() => {});

    const safe = {
      _id: userId,
      id: String(userId),
      email: originalEmail,
      name: displayName,
      deletedName: displayName,
      role: target.role,
    };
    emitUserEvent('user:deleted', safe);
    forceDisconnectUser(String(userId), {
      reason: 'deleted',
      name: displayName,
      message: 'Your account has been deleted. Please contact your administrator.',
    });

    await notifySuperAdmins({
      actorId,
      type: NOTIFICATION_TYPES.USER_DELETED,
      message: `Member "${displayName}" (${originalEmail}) was deleted`,
      entityType: 'User',
      entityId: userId,
      emailSubject: `Member deleted: ${displayName}`,
      emailToo: false,
    });

    return safe;
  }
}

module.exports = new UserService();
