const { Client, GatewayIntentBits, Partials, ActivityType, EmbedBuilder, PermissionsBitField, Colors } = require('discord.js');
const https = require('https');
const fs = require('fs');

const client = new Client({
    intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildPresences,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildModeration,
        ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

const PREFIX = '!';
const GUILD_ID = '1487503515512475792';
const ACCENT = 0x9b1a1a;
const CYAN   = 0x00e5ff;

// Role IDs
const STAFF_ROLES = ['Owner', 'Admin', 'Moderator', 'Support Staff'];

// Warn storage (in-memory, resets on restart - good enough for a small server)
const warns = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function isStaff(member) {
    return member.roles.cache.some(r => STAFF_ROLES.includes(r.name));
}

function isTicketChannel(channel) {
    // Ticket Tool names tickets: ticket-0001, ticket-0002, etc.
  return /^ticket-\d+$/i.test(channel.name) || channel.name.toLowerCase().startsWith('ticket-');
}

function embed(color, desc, title) {
    const e = new EmbedBuilder().setColor(color);
    if (title) e.setTitle(title);
    if (desc)  e.setDescription(desc);
    return e;
}

function staffEmbed(desc, title) { return embed(ACCENT, desc, title); }
function infoEmbed(desc, title)  { return embed(CYAN,   desc, title); }
function errEmbed(desc)          { return embed(0xff4444, desc); }
function okEmbed(desc)           { return embed(0x00cc66, desc); }

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`[RazorReaper] Online as ${client.user.tag}`);
    client.user.setPresence({
          activities: [{ name: 'rr.sellhub.cx | !help', type: ActivityType.Watching }],
          status: 'online',
    });

              // Set bot bio (about me) via REST
              try {
                    await client.rest.patch('/users/@me', {
                            body: { bio: '⚡ Official RazorReaper bot — ticket management, server info & moderation. Visit rr.sellhub.cx' },
                    });
              } catch (_) {}
});

// ── Welcome new members ────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
    const ch = member.guild.channels.cache.find(c => c.name.includes('welcome'));
    if (!ch) return;
    const e = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle('⚡ Welcome to RazorReaper!')
      .setDescription(
              `Hey ${member}, welcome to the community!\n\n` +
              `📋 Read the rules in <#${member.guild.channels.cache.find(c=>c.name.includes('rules'))?.id || 'rules'}>\n` +
              `🎟️ Need help? Open a ticket in create-ticket\n` +
              `🌐 Visit us at **rr.sellhub.cx**`
            )
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
      .setFooter({ text: `Member #${member.guild.memberCount}`, iconURL: client.user.displayAvatarURL() })
      .setTimestamp();
    ch.send({ embeds: [e] });
});

// ── Message Commands ──────────────────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;

            const args    = msg.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const guild   = msg.guild;
    const member  = msg.member;

            // ── !ping ──────────────────────────────────────────────────────────────────
            if (command === 'ping') {
                  const sent = await msg.reply({ embeds: [infoEmbed('⏱️ Pinging...')] });
                  const ms   = sent.createdTimestamp - msg.createdTimestamp;
                  sent.edit({ embeds: [infoEmbed(`⚡ Pong! \`${ms}ms\` | WS: \`${client.ws.ping}ms\``)] });
                  return;
            }

            // ── !help ──────────────────────────────────────────────────────────────────
            if (command === 'help') {
                  const isS = isStaff(member);
                  const e = new EmbedBuilder()
                    .setColor(ACCENT)
                    .setTitle('⚡ RazorReaper Bot — Commands')
                    .setDescription('Prefix: `!`  |  Visit **rr.sellhub.cx**')
                    .addFields(
                      { name: '🎟️ Ticket Commands', value:
                                  '`!ticket` — View your open ticket\n' +
                                  '`!queue` — See how many tickets are open\n' +
                                  '`!ticketinfo` — Info about current ticket *(inside ticket)*\n' +
                                  '`!adduser @user` — Add someone to current ticket *(inside ticket)*'
                      },
                      { name: '📊 Server Commands', value:
                                  '`!info` — Server statistics\n' +
                                  '`!userinfo [@user]` — User details\n' +
                                  '`!status` — Bot & server status\n' +
                                  '`!rules` — Display server rules'
                      },
                            );
                  if (isS) {
                          e.addFields({ name: '🔨 Staff Commands', value:
                                    '`!purge [1-100]` — Bulk delete messages\n' +
                                    '`!kick @user [reason]` — Kick a member\n' +
                                    '`!ban @user [reason]` — Ban a member\n' +
                                    '`!warn @user [reason]` — Warn a member\n' +
                                    '`!warns @user` — View warnings\n' +
                                    '`!clearwarns @user` — Clear warnings\n' +
                                    '`!close [reason]` — Close ticket *(inside ticket)*\n' +
                                    '`!say [#channel] <msg>` — Send announcement'
                                      });
                  }
                  e.setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() });
                  return msg.reply({ embeds: [e] });
            }

            // ── !info ──────────────────────────────────────────────────────────────────
            if (command === 'info') {
                  await guild.fetch();
                  const onlineCount = guild.members.cache.filter(m => m.presence?.status === 'online').size;
                  const boostTier   = guild.premiumTier === 0 ? 'No boost' : `Tier ${guild.premiumTier}`;
                  const e = new EmbedBuilder()
                    .setColor(ACCENT)
                    .setTitle(`⚙️ ${guild.name}`)
                    .setThumbnail(guild.iconURL({ dynamic: true }))
                    .addFields(
                      { name: '👥 Members',   value: `${guild.memberCount}`,    inline: true },
                      { name: '🟢 Online',    value: `${onlineCount}`,          inline: true },
                      { name: '🚀 Boost',     value: boostTier,                 inline: true },
                      { name: '📅 Created',   value: `<t:${Math.floor(guild.createdTimestamp/1000)}:R>`, inline: true },
                      { name: '👑 Owner',     value: `<@${guild.ownerId}>`,      inline: true },
                      { name: '🌐 Website',   value: '[rr.sellhub.cx](https://rr.sellhub.cx)', inline: true },
                            )
                    .setFooter({ text: 'RazorReaper', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                  return msg.reply({ embeds: [e] });
            }

            // ── !userinfo [@user] ──────────────────────────────────────────────────────
            if (command === 'userinfo') {
                  const target = msg.mentions.members.first() || member;
                  const roles  = target.roles.cache.filter(r => r.name !== '@everyone').sort((a,b) => b.position - a.position);
                  const topRoles = roles.first(5).map(r => r.toString()).join(' ') || 'None';
                  const e = new EmbedBuilder()
                    .setColor(CYAN)
                    .setTitle(`👤 ${target.user.username}`)
                    .setThumbnail(target.user.displayAvatarURL({ dynamic: true, size: 256 }))
                    .addFields(
                      { name: '🆔 User ID',      value: target.id,           inline: true },
                      { name: '📅 Joined Server', value: `<t:${Math.floor(target.joinedTimestamp/1000)}:R>`, inline: true },
                      { name: '🗓️ Account Age',  value: `<t:${Math.floor(target.user.createdTimestamp/1000)}:R>`, inline: true },
                      { name: '🏆 Top Role',     value: `${target.roles.highest}`, inline: true },
                      { name: '🤖 Bot?',         value: target.user.bot ? 'Yes' : 'No', inline: true },
                      { name: `📋 Roles (${roles.size})`, value: topRoles },
                            )
                    .setTimestamp();
                  return msg.reply({ embeds: [e] });
            }

            // ── !status ────────────────────────────────────────────────────────────────
            if (command === 'status') {
                  const uptime  = process.uptime();
                  const h = Math.floor(uptime / 3600);
                  const m = Math.floor((uptime % 3600) / 60);
                  const s = Math.floor(uptime % 60);
                  const openTickets = guild.channels.cache.filter(c => isTicketChannel(c)).size;
                  const e = infoEmbed(null, '📊 RazorReaper Status');
                  e.addFields(
                    { name: '🤖 Bot',        value: `Online ✅`,          inline: true },
                    { name: '⏱️ Uptime',    value: `${h}h ${m}m ${s}s`,  inline: true },
                    { name: '📡 Ping',      value: `${client.ws.ping}ms`, inline: true },
                    { name: '🎟️ Open Tickets', value: `${openTickets}`, inline: true },
                    { name: '👥 Members',   value: `${guild.memberCount}`, inline: true },
                    { name: '🌐 Website',   value: '[rr.sellhub.cx](https://rr.sellhub.cx)', inline: true },
                        ).setTimestamp();
                  return msg.reply({ embeds: [e] });
            }

            // ── !rules ──────────────────────────────────────────────────────────────────
            if (command === 'rules') {
                  const e = new EmbedBuilder()
                    .setColor(ACCENT)
                    .setTitle('📋 RazorReaper — Server Rules')
                    .setDescription(
                              '**1.** Be respectful to all members.\n' +
                              '**2.** No spam, advertising or self-promotion.\n' +
                              '**3.** No NSFW content.\n' +
                              '**4.** No doxxing or sharing personal info.\n' +
                              '**5.** Follow Discord\'s Terms of Service.\n' +
                              '**6.** Use channels for their intended purpose.\n' +
                              '**7.** All disputes go through the ticket system — do not DM staff.\n\n' +
                              '*Violations may result in a warn, kick or ban.*'
                            )
                    .setFooter({ text: 'RazorReaper | rr.sellhub.cx' });
                  return msg.reply({ embeds: [e] });
            }

            // ── !ticket ────────────────────────────────────────────────────────────────
            if (command === 'ticket') {
                  const userTickets = guild.channels.cache.filter(c =>
                          isTicketChannel(c) &&
                          c.permissionOverwrites.cache.has(msg.author.id)
                                                                      );
                  if (userTickets.size === 0) {
                          return msg.reply({ embeds: [infoEmbed(
                                    '❌ You have no open tickets.\n\nOpen one in <#' +
                                    (guild.channels.cache.find(c => c.name.includes('create-ticket'))?.id || 'create-ticket') +
                                    '>!'
                                  )] });
                  }
                  const list = userTickets.map(c => `• ${c} — \`${c.name}\``).join('\n');
                  return msg.reply({ embeds: [infoEmbed(
                          `🎟️ Your open ticket${userTickets.size > 1 ? 's' : ''}:\n${list}`
                        )] });
            }

            // ── !queue ─────────────────────────────────────────────────────────────────
            if (command === 'queue') {
                  const openTickets   = guild.channels.cache.filter(c => isTicketChannel(c));
                  const closedTickets = guild.channels.cache.filter(c => c.name.toLowerCase().startsWith('closed-'));
                  const e = infoEmbed(null, '🎟️ Ticket Queue');
                  e.addFields(
                    { name: '🟢 Open Tickets',   value: `${openTickets.size}`,   inline: true },
                    { name: '🔴 Closed Tickets', value: `${closedTickets.size}`,  inline: true },
                    { name: '📊 Total',          value: `${openTickets.size + closedTickets.size}`, inline: true },
                        );
                  if (isStaff(member) && openTickets.size > 0) {
                          const list = openTickets.map(c => `• ${c}`).join('\n');
                          e.addFields({ name: '📋 Open Channels', value: list.substring(0, 1024) });
                  }
                  return msg.reply({ embeds: [e] });
            }

            // ── !ticketinfo ─────────────────────────────────────────────────────────────
            if (command === 'ticketinfo') {
                  if (!isTicketChannel(msg.channel)) {
                          return msg.reply({ embeds: [errEmbed('❌ This command can only be used inside a ticket channel.')] });
                  }
                  const perms   = msg.channel.permissionOverwrites.cache;
                  const ticketOwner = perms.filter(p => p.type === 1 && p.id !== msg.guild.id)
                                           .find(p => p.allow.has(PermissionsBitField.Flags.ViewChannel));
                  const ownerUser = ticketOwner ? await client.users.fetch(ticketOwner.id).catch(() => null) : null;
                  const e = infoEmbed(null, `🎟️ Ticket Info — #${msg.channel.name}`);
                  e.addFields(
                    { name: '📛 Channel',   value: `${msg.channel}`,        inline: true },
                    { name: '👤 Owner',     value: ownerUser ? `<@${ownerUser.id}>` : 'Unknown', inline: true },
                    { name: '📅 Created',   value: `<t:${Math.floor(msg.channel.createdTimestamp/1000)}:R>`, inline: true },
                        ).setTimestamp();
                  return msg.reply({ embeds: [e] });
            }

            // ── !adduser @user ──────────────────────────────────────────────────────────
            if (command === 'adduser') {
                  if (!isTicketChannel(msg.channel)) {
                          return msg.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')] });
                  }
                  const target = msg.mentions.members.first();
                  if (!target) return msg.reply({ embeds: [errEmbed('❌ Mention a user to add.')] });
                  await msg.channel.permissionOverwrites.edit(target, {
                          ViewChannel: true,
                          SendMessages: true,
                          ReadMessageHistory: true,
                  });
                  return msg.reply({ embeds: [okEmbed(`✅ Added ${target} to this ticket.`)] });
            }

            // ── !close [reason] ────────────────────────────────────────────────────────
            if (command === 'close') {
                  if (!isTicketChannel(msg.channel)) {
                          return msg.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')] });
                  }
                  if (!isStaff(member) && !msg.channel.permissionOverwrites.cache.has(msg.author.id)) {
                          return msg.reply({ embeds: [errEmbed('❌ You do not have permission to close this ticket.')] });
                  }
                  const reason = args.join(' ') || 'No reason provided';
                  const e = new EmbedBuilder()
                    .setColor(0xff4444)
                    .setTitle('🔒 Ticket Closing')
                    .setDescription(`**Reason:** ${reason}\n\nThis ticket will be closed. The transcript will be saved.`)
                    .setFooter({ text: `Closed by ${msg.author.tag}` })
                    .setTimestamp();
                  await msg.channel.send({ embeds: [e] });
                  // Rename to closed- prefix so Ticket Tool picks it up
      const num = msg.channel.name.replace(/[^0-9]/g, '');
                  await msg.channel.setName(`closed-${num || '0000'}`).catch(() => {});
                  // Remove @everyone view so it disappears for non-staff
      await msg.channel.permissionOverwrites.edit(msg.guild.id, { ViewChannel: false }).catch(() => {});
                  return;
            }

            // ── !say [#channel] <message> ───────────────────────────────────────────────
            if (command === 'say') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });
                  const targetChannel = msg.mentions.channels.first() || msg.channel;
                  const text = args.filter(a => !a.startsWith('<#')).join(' ');
                  if (!text) return msg.reply({ embeds: [errEmbed('❌ Provide a message.')] });
                  await msg.delete().catch(() => {});
                  return targetChannel.send(text);
            }

            // ── !purge [n] ─────────────────────────────────────────────────────────────
            if (command === 'purge') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });
                  const n = parseInt(args[0]);
                  if (isNaN(n) || n < 1 || n > 100) return msg.reply({ embeds: [errEmbed('❌ Provide a number 1-100.')] });
                  const deleted = await msg.channel.bulkDelete(n + 1, true).catch(() => null);
                  if (!deleted) return msg.reply({ embeds: [errEmbed('❌ Cannot delete messages older than 14 days.')] });
                  const m = await msg.channel.send({ embeds: [okEmbed(`🗑️ Deleted **${deleted.size - 1}** messages.`)] });
                  setTimeout(() => m.delete().catch(() => {}), 3000);
                  return;
            }

            // ── !kick @user [reason] ───────────────────────────────────────────────────
            if (command === 'kick') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });
                  const target = msg.mentions.members.first();
                  if (!target) return msg.reply({ embeds: [errEmbed('❌ Mention a user.')] });
                  if (!target.kickable) return msg.reply({ embeds: [errEmbed('❌ Cannot kick this user.')] });
                  const reason = args.slice(1).join(' ') || 'No reason provided';
                  await target.kick(reason);
                  const e = staffEmbed(`✅ **${target.user.tag}** was kicked.\n**Reason:** ${reason}`, '👢 Member Kicked');
                  return msg.channel.send({ embeds: [e] });
            }

            // ── !ban @user [reason] ────────────────────────────────────────────────────
            if (command === 'ban') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });
                  const target = msg.mentions.members.first();
                  if (!target) return msg.reply({ embeds: [errEmbed('❌ Mention a user.')] });
                  if (!target.bannable) return msg.reply({ embeds: [errEmbed('❌ Cannot ban this user.')] });
                  const reason = args.slice(1).join(' ') || 'No reason provided';
                  await target.ban({ reason, deleteMessageSeconds: 86400 });
                  const e = staffEmbed(`✅ **${target.user.tag}** was banned.\n**Reason:** ${reason}`, '🔨 Member Banned');
                  return msg.channel.send({ embeds: [e] });
            }

            // ── !warn @user [reason] ───────────────────────────────────────────────────
            if (command === 'warn') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });
                  const target = msg.mentions.members.first();
                  if (!target) return msg.reply({ embeds: [errEmbed('❌ Mention a user.')] });
                  const reason = args.slice(1).join(' ') || 'No reason provided';
                  if (!warns[target.id]) warns[target.id] = [];
                  warns[target.id].push({ reason, mod: msg.author.tag, time: Date.now() });
                  const count = warns[target.id].length;
                  const e = staffEmbed(
                          `⚠️ **${target.user.tag}** has been warned.\n**Reason:** ${reason}\n**Total Warnings:** ${count}`,
                          '⚠️ Member Warned'
                        );
                  // DM the user
      target.send({ embeds: [infoEmbed(
              `⚠️ You received a warning in **${guild.name}**\n**Reason:** ${reason}\n**Total Warnings:** ${count}`
            )] }).catch(() => {});
                  return msg.channel.send({ embeds: [e] });
            }

            // ── !warns @user ───────────────────────────────────────────────────────────
            if (command === 'warns') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });
                  const target = msg.mentions.members.first() || member;
                  const userWarns = warns[target.id] || [];
                  if (userWarns.length === 0) {
                          return msg.reply({ embeds: [infoEmbed(`✅ **${target.user.tag}** has no warnings.`)] });
                  }
                  const list = userWarns.map((w, i) =>
                          `**${i + 1}.** ${w.reason} — *${w.mod}* — <t:${Math.floor(w.time / 1000)}:R>`
                                                 ).join('\n');
                  return msg.reply({ embeds: [staffEmbed(list, `⚠️ Warnings for ${target.user.tag} (${userWarns.length})`)] });
            }

            // ── !clearwarns @user ──────────────────────────────────────────────────────
            if (command === 'clearwarns') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });
                  const target = msg.mentions.members.first();
                  if (!target) return msg.reply({ embeds: [errEmbed('❌ Mention a user.')] });
                  warns[target.id] = [];
                  return msg.reply({ embeds: [okEmbed(`✅ Cleared all warnings for **${target.user.tag}**.`)] });
            }
});

client.login(process.env.TOKEN);
