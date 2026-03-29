const { Client, GatewayIntentBits, Partials, ActivityType, EmbedBuilder, PermissionsBitField, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder, SlashCommandBuilder, REST, Routes, ChannelType, ApplicationCommandOptionType } = require('discord.js');
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
    return member.id === member.guild.ownerId ||
           member.permissions.has(PermissionsBitField.Flags.Administrator) ||
           member.roles.cache.some(r => STAFF_ROLES.includes(r.name));
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

// ── Slash Command Definitions ─────────────────────────────────────────────────
const slashCommands = [
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency and WebSocket ping'),
    new SlashCommandBuilder().setName('help').setDescription('View all bot commands with an interactive menu'),
    new SlashCommandBuilder().setName('info').setDescription('View server statistics'),
    new SlashCommandBuilder().setName('userinfo').setDescription('View detailed user profile')
        .addUserOption(o => o.setName('user').setDescription('The user to look up (leave empty for yourself)').setRequired(false)),
    new SlashCommandBuilder().setName('status').setDescription('View bot & server status — uptime, ping, tickets'),
    new SlashCommandBuilder().setName('rules').setDescription('Display the server rules'),
    new SlashCommandBuilder().setName('ticket').setDescription('View your open tickets'),
    new SlashCommandBuilder().setName('queue').setDescription('See how many tickets are open'),
    new SlashCommandBuilder().setName('ticketinfo').setDescription('View info about the current ticket (use inside a ticket channel)'),
    new SlashCommandBuilder().setName('adduser').setDescription('Add a user to the current ticket')
        .addUserOption(o => o.setName('user').setDescription('The user to add to this ticket').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close the current ticket')
        .addStringOption(o => o.setName('reason').setDescription('Reason for closing the ticket').setRequired(false)),
    new SlashCommandBuilder().setName('say').setDescription('Send a message as the bot')
        .addStringOption(o => o.setName('message').setDescription('The message to send').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('Channel to send in (default: current)').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('clear').setDescription('Delete messages in this channel')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete').setRequired(true)
            .addChoices({ name: '10 messages', value: 10 }, { name: '25 messages', value: 25 }, { name: '50 messages', value: 50 }, { name: '100 messages', value: 100 }))
        .addStringOption(o => o.setName('filter').setDescription('Filter messages by type').setRequired(true)
            .addChoices({ name: 'All messages', value: 'all' }, { name: 'Specific user', value: 'user' }, { name: 'Bots only', value: 'bots' }))
        .addUserOption(o => o.setName('user').setDescription('User to filter by (only when filter = Specific user)').setRequired(false)),
    new SlashCommandBuilder().setName('purge').setDescription('Quick bulk-delete messages')
        .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a member from the server')
        .addUserOption(o => o.setName('user').setDescription('The member to kick').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the kick').setRequired(false)),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a member from the server')
        .addUserOption(o => o.setName('user').setDescription('The member to ban').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(false)),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
        .addUserOption(o => o.setName('user').setDescription('The member to warn').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(false)),
    new SlashCommandBuilder().setName('warns').setDescription('View warnings for a member')
        .addUserOption(o => o.setName('user').setDescription('The member to check (leave empty for yourself)').setRequired(false)),
    new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a member')
        .addUserOption(o => o.setName('user').setDescription('The member to clear warnings for').setRequired(true)),
    new SlashCommandBuilder().setName('steal').setDescription('Steal emojis to this server or download them')
        .addStringOption(o => o.setName('emojis').setDescription('Paste emojis here (up to 5, separated by spaces)').setRequired(true)),
    new SlashCommandBuilder().setName('stealsticker').setDescription('Steal a sticker — reply to a sticker message first, then use this command')
        .addStringOption(o => o.setName('name').setDescription('Custom name for the sticker').setRequired(false)),
];

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`[RazorReaper] Online as ${client.user.tag}`);
    client.user.setPresence({
          activities: [{ name: 'rr.sellhub.cx | /help', type: ActivityType.Watching }],
          status: 'online',
    });

    // Register slash commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
        console.log('[RazorReaper] Registering slash commands...');
        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
            body: slashCommands.map(c => c.toJSON()),
        });
        console.log('[RazorReaper] Slash commands registered!');
    } catch (err) {
        console.error('[RazorReaper] Failed to register slash commands:', err);
    }

    // Set bot bio + banner
    try {
        const path = require('path');
        const bannerPath = path.join(__dirname, 'banner.png');
        const bannerData = fs.readFileSync(bannerPath);
        const bannerBase64 = `data:image/png;base64,${bannerData.toString('base64')}`;
        await client.rest.patch('/users/@me', {
            body: {
                bio: '⚡ Official RazorReaper bot — ticket management, server info & moderation. Visit rr.sellhub.cx',
                banner: bannerBase64,
            },
        });
        console.log('[RazorReaper] Banner & bio set!');
    } catch (err) {
        console.error('[RazorReaper] Failed to set banner/bio:', err.message || err);
    }
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

                  // Category embeds
                  const helpCategories = {
                          home: () => {
                                  const e = new EmbedBuilder()
                                    .setColor(ACCENT)
                                    .setTitle('⚡ RazorReaper Bot')
                                    .setDescription(
                                            'Welcome to the **RazorReaper** help menu!\n\n' +
                                            'Use the dropdown below to browse command categories.\n\n' +
                                            '**Slash Commands:** `/command`\n' +
                                            '**Prefix:** `!command`\n' +
                                            '**Website:** [rr.sellhub.cx](https://rr.sellhub.cx)'
                                    )
                                    .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 }))
                                    .addFields(
                                            { name: '📂 Categories', value:
                                                    '🎟️ **Tickets** — Manage support tickets\n' +
                                                    '📊 **Server** — Server info & utilities\n' +
                                                    '😎 **Emoji** — Steal emojis & stickers\n' +
                                                    (isS ? '🛡️ **Admin** — Channel management & tools\n' +
                                                    '🔨 **Staff** — Moderation & member management\n' : '')
                                            },
                                    )
                                    .setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() })
                                    .setTimestamp();
                                  return e;
                          },
                          tickets: () => new EmbedBuilder()
                            .setColor(ACCENT)
                            .setTitle('🎟️ Ticket Commands')
                            .setDescription('Manage and interact with the ticket system.')
                            .addFields(
                                    { name: '`!ticket`', value: 'View your open ticket(s)' },
                                    { name: '`!queue`', value: 'See how many tickets are open' },
                                    { name: '`!ticketinfo`', value: 'Info about current ticket *(use inside a ticket channel)*' },
                                    { name: '`!adduser @user`', value: 'Add someone to current ticket *(use inside a ticket channel)*' },
                            )
                            .setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
                          server: () => new EmbedBuilder()
                            .setColor(CYAN)
                            .setTitle('📊 Server Commands')
                            .setDescription('View server info and utilities.')
                            .addFields(
                                    { name: '`!info`', value: 'Server statistics — members, boosts, creation date and more' },
                                    { name: '`!userinfo [@user]`', value: 'Detailed user profile — roles, join date, account age' },
                                    { name: '`!status`', value: 'Bot & server status — uptime, ping, open tickets' },
                                    { name: '`!rules`', value: 'Display the server rules' },
                                    { name: '`!ping`', value: 'Check bot latency and WebSocket ping' },
                            )
                            .setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
                          emoji: () => new EmbedBuilder()
                            .setColor(0xffcc00)
                            .setTitle('😎 Emoji & Sticker Commands')
                            .setDescription(
                                    'Steal emojis and stickers from other servers!\n\n' +
                                    'Everyone can **download** emojis. Only staff can **steal to server**.'
                            )
                            .addFields(
                                    { name: '`!steal <emoji(s)>`', value: 'Steal one or more emojis — shows a selection menu with **Steal / Download / Both** options' },
                                    { name: '`!steal` *(reply)*', value: 'Reply to a message to steal all custom emojis from it' },
                                    { name: '`!steal <emoji_id> [name]`', value: 'Steal an emoji by its raw ID' },
                                    { name: '`!steal <image_url> [name]`', value: 'Create an emoji from an image URL' },
                                    { name: '`!stealsticker` *(reply)*', value: 'Reply to a sticker message to steal or download it' },
                            )
                            .setFooter({ text: 'Download: everyone | Steal to server: staff only', iconURL: client.user.displayAvatarURL() }),
                          admin: () => new EmbedBuilder()
                            .setColor(0x9b59b6)
                            .setTitle('🛡️ Admin Commands')
                            .setDescription('Channel management and administrative tools. Staff only.')
                            .addFields(
                                    { name: '`!clear`', value: 'Interactive message cleaner — select amount, target and filter from dropdown menus\nOptions: **10 / 25 / 50 / 100** messages | Filter by **All / Specific user / Bots only**' },
                                    { name: '`!purge [1-100]`', value: 'Quick bulk-delete messages (includes your command message)' },
                                    { name: '`!say [#channel] <msg>`', value: 'Send an announcement as the bot — optionally in a different channel' },
                                    { name: '`!close [reason]`', value: 'Close a ticket channel *(use inside a ticket channel)*' },
                            )
                            .setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
                          staff: () => new EmbedBuilder()
                            .setColor(0xff4444)
                            .setTitle('🔨 Staff Commands')
                            .setDescription('Member moderation and management. Staff only.')
                            .addFields(
                                    { name: '`!kick @user [reason]`', value: 'Kick a member from the server with an optional reason' },
                                    { name: '`!ban @user [reason]`', value: 'Ban a member from the server with an optional reason' },
                                    { name: '`!warn @user [reason]`', value: 'Issue a warning to a member — they get a DM notification' },
                                    { name: '`!warns @user`', value: 'View all warnings for a member' },
                                    { name: '`!clearwarns @user`', value: 'Clear all warnings for a member' },
                            )
                            .setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
                  };

                  // Build the select menu
                  const options = [
                          { label: 'Home', description: 'Main help overview', value: 'home', emoji: '⚡' },
                          { label: 'Tickets', description: 'Ticket system commands', value: 'tickets', emoji: '🎟️' },
                          { label: 'Server', description: 'Server info & utilities', value: 'server', emoji: '📊' },
                          { label: 'Emoji & Stickers', description: 'Steal emojis & stickers', value: 'emoji', emoji: '😎' },
                  ];
                  if (isS) {
                          options.push({ label: 'Admin', description: 'Channel management & tools', value: 'admin', emoji: '🛡️' });
                          options.push({ label: 'Staff', description: 'Member moderation', value: 'staff', emoji: '🔨' });
                  }

                  const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`help_menu_${msg.id}`)
                    .setPlaceholder('Select a category...')
                    .addOptions(options);

                  const row = new ActionRowBuilder().addComponents(selectMenu);
                  const reply = await msg.reply({ embeds: [helpCategories.home()], components: [row] });

                  const collector = reply.createMessageComponentCollector({
                          filter: (i) => i.user.id === msg.author.id,
                          time: 120_000,
                  });

                  collector.on('collect', async (interaction) => {
                          const category = interaction.values[0];
                          const builder = helpCategories[category];
                          if (builder) {
                                  await interaction.update({ embeds: [builder()] });
                          }
                  });

                  collector.on('end', () => {
                          reply.edit({ components: [] }).catch(() => {});
                  });
                  return;
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

            // ── !clear (interactive) ───────────────────────────────────────────────
            if (command === 'clear') {
                  if (!isStaff(member)) return msg.reply({ embeds: [errEmbed('❌ No permission.')] });

                  // State
                  let selectedAmount = null;
                  let selectedFilter = 'all'; // all | user | bots
                  let selectedUser = null;

                  // Amount select menu
                  const amountMenu = new StringSelectMenuBuilder()
                    .setCustomId(`clear_amount_${msg.id}`)
                    .setPlaceholder('Select amount of messages...')
                    .addOptions([
                            { label: '10 Messages', value: '10', emoji: '🔟' },
                            { label: '25 Messages', value: '25', emoji: '📄' },
                            { label: '50 Messages', value: '50', emoji: '📑' },
                            { label: '100 Messages', value: '100', emoji: '📚' },
                    ]);

                  // Filter select menu
                  const filterMenu = new StringSelectMenuBuilder()
                    .setCustomId(`clear_filter_${msg.id}`)
                    .setPlaceholder('Filter messages by...')
                    .addOptions([
                            { label: 'All Messages', description: 'Delete messages from everyone', value: 'all', emoji: '📨' },
                            { label: 'Specific User', description: 'Mention a user after selecting', value: 'user', emoji: '👤' },
                            { label: 'Bots Only', description: 'Only delete bot messages', value: 'bots', emoji: '🤖' },
                    ]);

                  const confirmRow = new ActionRowBuilder().addComponents(
                          new ButtonBuilder()
                            .setCustomId(`clear_confirm_${msg.id}`)
                            .setLabel('Clear Messages')
                            .setStyle(ButtonStyle.Danger)
                            .setEmoji('🗑️')
                            .setDisabled(true),
                          new ButtonBuilder()
                            .setCustomId(`clear_cancel_${msg.id}`)
                            .setLabel('Cancel')
                            .setStyle(ButtonStyle.Secondary),
                  );

                  const clearEmbed = new EmbedBuilder()
                    .setColor(0x9b59b6)
                    .setTitle('🗑️ Channel Clear')
                    .setDescription(
                            '**Step 1:** Select how many messages to delete\n' +
                            '**Step 2:** Choose a filter\n' +
                            '**Step 3:** Confirm\n\n' +
                            '> **Amount:** *not selected*\n' +
                            '> **Filter:** *not selected*'
                    )
                    .setFooter({ text: `Requested by ${msg.author.tag} • Expires in 60s` })
                    .setTimestamp();

                  const clearReply = await msg.reply({
                          embeds: [clearEmbed],
                          components: [
                                  new ActionRowBuilder().addComponents(amountMenu),
                                  new ActionRowBuilder().addComponents(filterMenu),
                                  confirmRow,
                          ],
                  });

                  function updateEmbed() {
                          const amountText = selectedAmount ? `**${selectedAmount}** messages` : '*not selected*';
                          let filterText = '*not selected*';
                          if (selectedFilter === 'all') filterText = '**All messages**';
                          else if (selectedFilter === 'bots') filterText = '**Bots only**';
                          else if (selectedFilter === 'user' && selectedUser) filterText = `**From:** ${selectedUser}`;
                          else if (selectedFilter === 'user') filterText = '**Specific user** — mention a user in chat';

                          clearEmbed.setDescription(
                                  '**Step 1:** Select how many messages to delete\n' +
                                  '**Step 2:** Choose a filter\n' +
                                  '**Step 3:** Confirm\n\n' +
                                  `> **Amount:** ${amountText}\n` +
                                  `> **Filter:** ${filterText}`
                          );
                  }

                  // Listen for user mention if "Specific User" is selected
                  const mentionCollector = msg.channel.createMessageCollector({
                          filter: (m) => m.author.id === msg.author.id && m.mentions.users.size > 0,
                          time: 60_000,
                  });

                  mentionCollector.on('collect', async (m) => {
                          if (selectedFilter !== 'user') return;
                          selectedUser = m.mentions.users.first();
                          await m.delete().catch(() => {});
                          updateEmbed();
                          const canConfirm = selectedAmount && (selectedFilter !== 'user' || selectedUser);
                          confirmRow.components[0].setDisabled(!canConfirm);
                          await clearReply.edit({ embeds: [clearEmbed], components: clearReply.components }).catch(() => {});
                  });

                  const clearCollector = clearReply.createMessageComponentCollector({
                          filter: (i) => i.user.id === msg.author.id,
                          time: 60_000,
                  });

                  clearCollector.on('collect', async (interaction) => {
                          if (interaction.customId === `clear_cancel_${msg.id}`) {
                                  clearCollector.stop('cancelled');
                                  mentionCollector.stop();
                                  return interaction.update({ embeds: [errEmbed('❌ Clear cancelled.')], components: [] });
                          }

                          if (interaction.customId === `clear_amount_${msg.id}`) {
                                  selectedAmount = parseInt(interaction.values[0]);
                                  updateEmbed();
                                  const canConfirm = selectedAmount && (selectedFilter !== 'user' || selectedUser);
                                  confirmRow.components[0].setDisabled(!canConfirm);
                                  return interaction.update({ embeds: [clearEmbed] });
                          }

                          if (interaction.customId === `clear_filter_${msg.id}`) {
                                  selectedFilter = interaction.values[0];
                                  if (selectedFilter !== 'user') selectedUser = null;
                                  updateEmbed();
                                  const canConfirm = selectedAmount && (selectedFilter !== 'user' || selectedUser);
                                  confirmRow.components[0].setDisabled(!canConfirm);
                                  return interaction.update({ embeds: [clearEmbed] });
                          }

                          if (interaction.customId === `clear_confirm_${msg.id}`) {
                                  clearCollector.stop('confirmed');
                                  mentionCollector.stop();
                                  await interaction.update({
                                          embeds: [infoEmbed('🗑️ Clearing messages...')],
                                          components: [],
                                  });

                                  let totalDeleted = 0;
                                  let remaining = selectedAmount;

                                  while (remaining > 0) {
                                          const fetchAmount = Math.min(remaining, 100);
                                          const fetched = await msg.channel.messages.fetch({ limit: fetchAmount }).catch(() => null);
                                          if (!fetched || fetched.size === 0) break;

                                          let toDelete = fetched;
                                          // Don't delete the bot's clear UI message
                                          toDelete = toDelete.filter(m => m.id !== clearReply.id);

                                          if (selectedFilter === 'user' && selectedUser) {
                                                  toDelete = toDelete.filter(m => m.author.id === selectedUser.id);
                                          } else if (selectedFilter === 'bots') {
                                                  toDelete = toDelete.filter(m => m.author.bot);
                                          }

                                          const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
                                          toDelete = toDelete.filter(m => m.createdTimestamp > twoWeeksAgo);

                                          if (toDelete.size === 0) break;

                                          const deleted = await msg.channel.bulkDelete(toDelete, true).catch(() => null);
                                          if (!deleted || deleted.size === 0) break;

                                          totalDeleted += deleted.size;
                                          remaining -= fetchAmount;

                                          if (remaining > 0) await new Promise(r => setTimeout(r, 1000));
                                  }

                                  let desc = `🗑️ Deleted **${totalDeleted}** messages`;
                                  if (selectedFilter === 'user' && selectedUser) desc += ` from ${selectedUser}`;
                                  else if (selectedFilter === 'bots') desc += ' from bots';
                                  desc += ' in this channel.';

                                  await clearReply.edit({ embeds: [okEmbed(desc)] });
                                  setTimeout(() => clearReply.delete().catch(() => {}), 5000);
                          }
                  });

                  clearCollector.on('end', (_, reason) => {
                          mentionCollector.stop();
                          if (reason === 'time') {
                                  clearReply.edit({ embeds: [errEmbed('⏰ Clear timed out.')], components: [] }).catch(() => {});
                          }
                  });
                  return;
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

            // ── !stealemoji / !steal ────────────────────────────────────────────────
            if (command === 'stealemoji' || command === 'steal') {
                  const canStealToServer = isStaff(member);

                  // Collect all emojis from args + replied message
                  const emojiRegex = /<(a?):(\w+):(\d+)>/g;
                  const found = [];

                  // Parse emojis from command arguments
                  const fullArgs = args.join(' ');
                  for (const match of fullArgs.matchAll(emojiRegex)) {
                          found.push({ animated: match[1] === 'a', name: match[2], id: match[3] });
                  }

                  // Parse emojis from replied message — also detect stickers
                  if (msg.reference) {
                          const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
                          if (ref) {
                                  for (const match of ref.content.matchAll(emojiRegex)) {
                                          if (!found.some(e => e.id === match[3])) {
                                                  found.push({ animated: match[1] === 'a', name: match[2], id: match[3] });
                                          }
                                  }
                                  // If no emojis found but message has stickers, redirect to stealsticker logic
                                  if (found.length === 0 && ref.stickers.size > 0) {
                                          const sticker = ref.stickers.first();
                                          const stickerName = args[0] || sticker.name;
                                          const stickerButtons = new ActionRowBuilder().addComponents(
                                                  new ButtonBuilder()
                                                    .setCustomId(`sticker_add_${msg.id}`)
                                                    .setLabel('Steal to Server')
                                                    .setStyle(ButtonStyle.Success)
                                                    .setEmoji('😎')
                                                    .setDisabled(!canStealToServer),
                                                  new ButtonBuilder()
                                                    .setCustomId(`sticker_dl_${msg.id}`)
                                                    .setLabel('Download')
                                                    .setStyle(ButtonStyle.Primary)
                                                    .setEmoji('📥'),
                                                  new ButtonBuilder()
                                                    .setCustomId(`sticker_both_${msg.id}`)
                                                    .setLabel('Steal + Download')
                                                    .setStyle(ButtonStyle.Secondary)
                                                    .setEmoji('⚡')
                                                    .setDisabled(!canStealToServer),
                                                  new ButtonBuilder()
                                                    .setCustomId(`sticker_cancel_${msg.id}`)
                                                    .setLabel('Cancel')
                                                    .setStyle(ButtonStyle.Danger),
                                          );
                                          const stickerEmbed = new EmbedBuilder()
                                            .setColor(CYAN)
                                            .setTitle('🎨 Sticker Found!')
                                            .setDescription(`**Sticker:** ${stickerName}\n**Format:** ${sticker.format}`)
                                            .setThumbnail(sticker.url)
                                            .setFooter({ text: 'Choose an action below. Expires in 60s.' })
                                            .setTimestamp();
                                          const stickerReply = await msg.reply({ embeds: [stickerEmbed], components: [stickerButtons] });
                                          const stickerCollector = stickerReply.createMessageComponentCollector({
                                                  filter: (i) => i.user.id === msg.author.id, time: 60_000,
                                          });
                                          stickerCollector.on('collect', async (interaction) => {
                                                  if (interaction.customId === `sticker_cancel_${msg.id}`) {
                                                          stickerCollector.stop('cancelled');
                                                          return interaction.update({ embeds: [errEmbed('❌ Cancelled.')], components: [] });
                                                  }
                                                  const doSteal = interaction.customId.includes('_add_') || interaction.customId.includes('_both_');
                                                  const doDownload = interaction.customId.includes('_dl_') || interaction.customId.includes('_both_');
                                                  await interaction.deferUpdate();
                                                  stickerCollector.stop('acted');
                                                  const results = [];
                                                  const files = [];
                                                  if (doSteal) {
                                                          try {
                                                                  const created = await guild.stickers.create({ file: sticker.url, name: stickerName, tags: '😀' });
                                                                  results.push(`✅ Added sticker **${created.name}** to the server!`);
                                                          } catch (e) { results.push(`❌ Failed: ${e.message}`); }
                                                  }
                                                  if (doDownload) {
                                                          const ext = sticker.format === 'LOTTIE' ? 'json' : 'png';
                                                          files.push(new AttachmentBuilder(sticker.url, { name: `${stickerName}.${ext}` }));
                                                          results.push('📥 Sticker file attached!');
                                                  }
                                                  await stickerReply.edit({ embeds: [okEmbed(results.join('\n'))], components: [], files });
                                          });
                                          stickerCollector.on('end', (_, reason) => {
                                                  if (reason === 'time') stickerReply.edit({ embeds: [errEmbed('⏰ Timed out.')], components: [] }).catch(() => {});
                                          });
                                          return;
                                  }
                          }
                  }

                  // Handle single emoji ID or URL (no selection needed)
                  if (found.length === 0 && args[0]) {
                          if (/^\d+$/.test(args[0])) {
                                  found.push({ animated: false, name: args[1] || 'stolen_emoji', id: args[0], tryGif: true });
                          } else if (args[0].startsWith('http')) {
                                  const eName = args[1] || 'stolen_emoji';
                                  try {
                                          const emoji = await guild.emojis.create({ attachment: args[0], name: eName });
                                          return msg.reply({ embeds: [okEmbed(`✅ Added ${emoji} as \`:${eName}:\``)] });
                                  } catch (e) {
                                          return msg.reply({ embeds: [errEmbed(`❌ Failed to create emoji: ${e.message}`)] });
                                  }
                          }
                  }

                  if (found.length === 0) {
                          return msg.reply({ embeds: [errEmbed('❌ No custom emojis found.\n**Usage:** `!steal <emoji(s)>` or reply to a message with `!steal`')] });
                  }

                  // Build emoji list for the preview embed
                  const emojiList = found.map((e, i) =>
                          `**${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`
                  ).join('\n');

                  const previewEmbed = new EmbedBuilder()
                    .setColor(CYAN)
                    .setTitle('😎 Emoji Stealer — Select & Choose')
                    .setDescription(`Found **${found.length}** emoji(s):\n\n${emojiList}`)
                    .setFooter({ text: 'Select emojis below, then choose to steal or download. Expires in 60s.' })
                    .setTimestamp();

                  // Build select menu if multiple emojis
                  const components = [];
                  if (found.length > 1) {
                          const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId(`steal_select_${msg.id}`)
                            .setPlaceholder('Select emojis to steal/download...')
                            .setMinValues(1)
                            .setMaxValues(found.length)
                            .addOptions(found.map((e, i) => ({
                                    label: `:${e.name}:`,
                                    description: e.animated ? 'Animated emoji' : 'Static emoji',
                                    value: String(i),
                                    emoji: { id: e.id, animated: e.animated },
                            })));
                          components.push(new ActionRowBuilder().addComponents(selectMenu));
                  }

                  // Action buttons — steal options disabled for non-staff
                  const buttons = new ActionRowBuilder().addComponents(
                          new ButtonBuilder()
                            .setCustomId(`steal_add_${msg.id}`)
                            .setLabel('Steal to Server')
                            .setStyle(ButtonStyle.Success)
                            .setEmoji('😎')
                            .setDisabled(!canStealToServer),
                          new ButtonBuilder()
                            .setCustomId(`steal_dl_${msg.id}`)
                            .setLabel('Download')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📥'),
                          new ButtonBuilder()
                            .setCustomId(`steal_both_${msg.id}`)
                            .setLabel('Steal + Download')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('⚡')
                            .setDisabled(!canStealToServer),
                          new ButtonBuilder()
                            .setCustomId(`steal_cancel_${msg.id}`)
                            .setLabel('Cancel')
                            .setStyle(ButtonStyle.Danger),
                  );
                  components.push(buttons);

                  const reply = await msg.reply({ embeds: [previewEmbed], components });

                  // Track selected emoji indices (default: all)
                  let selectedIndices = found.map((_, i) => i);

                  const collector = reply.createMessageComponentCollector({
                          filter: (i) => i.user.id === msg.author.id,
                          time: 60_000,
                  });

                  collector.on('collect', async (interaction) => {
                          // Handle select menu
                          if (interaction.customId === `steal_select_${msg.id}`) {
                                  selectedIndices = interaction.values.map(Number);
                                  const selected = selectedIndices.map(i => found[i]);
                                  const updatedList = found.map((e, i) =>
                                          `${selectedIndices.includes(i) ? '✅' : '⬜'} **${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`
                                  ).join('\n');
                                  previewEmbed.setDescription(`Found **${found.length}** emoji(s) — **${selected.length}** selected:\n\n${updatedList}`);
                                  await interaction.update({ embeds: [previewEmbed] });
                                  return;
                          }

                          // Handle cancel
                          if (interaction.customId === `steal_cancel_${msg.id}`) {
                                  collector.stop('cancelled');
                                  await interaction.update({
                                          embeds: [errEmbed('❌ Emoji steal cancelled.')],
                                          components: [],
                                  });
                                  return;
                          }

                          // Determine action
                          const doSteal = interaction.customId === `steal_add_${msg.id}` || interaction.customId === `steal_both_${msg.id}`;
                          const doDownload = interaction.customId === `steal_dl_${msg.id}` || interaction.customId === `steal_both_${msg.id}`;

                          await interaction.deferUpdate();
                          collector.stop('acted');

                          const selected = selectedIndices.map(i => found[i]);
                          const results = [];
                          const attachments = [];

                          for (const emoji of selected) {
                                  const ext = emoji.animated ? 'gif' : 'png';
                                  let url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;

                                  if (doSteal) {
                                          try {
                                                  const created = await guild.emojis.create({ attachment: url, name: emoji.name });
                                                  results.push(`✅ ${created} \`:${emoji.name}:\` — added to server`);
                                          } catch (e) {
                                                  // If ID-only emoji, try the other format
                                                  if (emoji.tryGif) {
                                                          url = `https://cdn.discordapp.com/emojis/${emoji.id}.gif`;
                                                          try {
                                                                  const created = await guild.emojis.create({ attachment: url, name: emoji.name });
                                                                  results.push(`✅ ${created} \`:${emoji.name}:\` — added to server`);
                                                                  continue;
                                                          } catch {}
                                                  }
                                                  results.push(`❌ \`:${emoji.name}:\` — ${e.message}`);
                                          }
                                  }

                                  if (doDownload) {
                                          try {
                                                  const attachment = new AttachmentBuilder(url, { name: `${emoji.name}.${ext}` });
                                                  attachments.push(attachment);
                                                  if (!doSteal) results.push(`📥 \`:${emoji.name}:\` — downloaded`);
                                                  else results.push(`📥 \`:${emoji.name}:\` — file attached`);
                                          } catch (e) {
                                                  results.push(`❌ \`:${emoji.name}:\` download failed — ${e.message}`);
                                          }
                                  }
                          }

                          const resultEmbed = new EmbedBuilder()
                            .setColor(0x00cc66)
                            .setTitle('😎 Emoji Steal — Results')
                            .setDescription(results.join('\n'))
                            .setFooter({ text: `Requested by ${msg.author.tag}` })
                            .setTimestamp();

                          await reply.edit({
                                  embeds: [resultEmbed],
                                  components: [],
                                  files: attachments,
                          });
                  });

                  collector.on('end', (_, reason) => {
                          if (reason === 'time') {
                                  reply.edit({
                                          embeds: [errEmbed('⏰ Emoji steal timed out.')],
                                          components: [],
                                  }).catch(() => {});
                          }
                  });
                  return;
            }

            // ── !stealsticker ──────────────────────────────────────────────────────────
            if (command === 'stealsticker') {
                  const canStealStickerToServer = isStaff(member);
                  const ref = msg.reference ? await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null) : null;
                  if (!ref || ref.stickers.size === 0) {
                          return msg.reply({ embeds: [errEmbed('❌ Reply to a message that has a sticker.\n**Usage:** Reply to a sticker message with `!stealsticker [name]`')] });
                  }
                  const sticker = ref.stickers.first();
                  const stickerName = args[0] || sticker.name;

                  const buttons = new ActionRowBuilder().addComponents(
                          new ButtonBuilder()
                            .setCustomId(`sticker_add_${msg.id}`)
                            .setLabel('Steal to Server')
                            .setStyle(ButtonStyle.Success)
                            .setEmoji('😎')
                            .setDisabled(!canStealStickerToServer),
                          new ButtonBuilder()
                            .setCustomId(`sticker_dl_${msg.id}`)
                            .setLabel('Download')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('📥'),
                          new ButtonBuilder()
                            .setCustomId(`sticker_both_${msg.id}`)
                            .setLabel('Steal + Download')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('⚡')
                            .setDisabled(!canStealStickerToServer),
                          new ButtonBuilder()
                            .setCustomId(`sticker_cancel_${msg.id}`)
                            .setLabel('Cancel')
                            .setStyle(ButtonStyle.Danger),
                  );

                  const previewEmbed = new EmbedBuilder()
                    .setColor(CYAN)
                    .setTitle('🎨 Sticker Stealer')
                    .setDescription(`**Sticker:** ${stickerName}\n**Format:** ${sticker.format}`)
                    .setThumbnail(sticker.url)
                    .setFooter({ text: 'Choose an action below. Expires in 60s.' })
                    .setTimestamp();

                  const reply = await msg.reply({ embeds: [previewEmbed], components: [buttons] });

                  const collector = reply.createMessageComponentCollector({
                          filter: (i) => i.user.id === msg.author.id,
                          time: 60_000,
                  });

                  collector.on('collect', async (interaction) => {
                          if (interaction.customId === `sticker_cancel_${msg.id}`) {
                                  collector.stop('cancelled');
                                  await interaction.update({ embeds: [errEmbed('❌ Sticker steal cancelled.')], components: [] });
                                  return;
                          }

                          const doSteal = interaction.customId === `sticker_add_${msg.id}` || interaction.customId === `sticker_both_${msg.id}`;
                          const doDownload = interaction.customId === `sticker_dl_${msg.id}` || interaction.customId === `sticker_both_${msg.id}`;

                          await interaction.deferUpdate();
                          collector.stop('acted');

                          const results = [];
                          const attachments = [];

                          if (doSteal) {
                                  try {
                                          const created = await guild.stickers.create({ file: sticker.url, name: stickerName, tags: '😀' });
                                          results.push(`✅ Added sticker **${created.name}** to the server!`);
                                  } catch (e) {
                                          results.push(`❌ Failed to steal sticker: ${e.message}`);
                                  }
                          }

                          if (doDownload) {
                                  try {
                                          const ext = sticker.format === 'LOTTIE' ? 'json' : sticker.format === 'APNG' ? 'png' : 'png';
                                          const attachment = new AttachmentBuilder(sticker.url, { name: `${stickerName}.${ext}` });
                                          attachments.push(attachment);
                                          results.push(`📥 Sticker file attached!`);
                                  } catch (e) {
                                          results.push(`❌ Download failed: ${e.message}`);
                                  }
                          }

                          await reply.edit({
                                  embeds: [okEmbed(results.join('\n'))],
                                  components: [],
                                  files: attachments,
                          });
                  });

                  collector.on('end', (_, reason) => {
                          if (reason === 'time') {
                                  reply.edit({ embeds: [errEmbed('⏰ Sticker steal timed out.')], components: [] }).catch(() => {});
                          }
                  });
                  return;
            }
});

// ── Slash Command Handler ─────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member, channel } = interaction;

    // ── /ping ─────────────────────────────────────────────────────────────────
    if (commandName === 'ping') {
        const sent = await interaction.reply({ embeds: [infoEmbed('⏱️ Pinging...')], fetchReply: true });
        const ms = sent.createdTimestamp - interaction.createdTimestamp;
        return sent.edit({ embeds: [infoEmbed(`⚡ Pong! \`${ms}ms\` | WS: \`${client.ws.ping}ms\``)] });
    }

    // ── /help ─────────────────────────────────────────────────────────────────
    if (commandName === 'help') {
        const isS = isStaff(member);
        const helpCategories = {
            home: () => new EmbedBuilder()
                .setColor(ACCENT)
                .setTitle('⚡ RazorReaper Bot')
                .setDescription(
                    'Welcome to the **RazorReaper** help menu!\n\n' +
                    'Use the dropdown below to browse command categories.\n\n' +
                    '**Slash Commands:** `/command`\n' +
                    '**Prefix:** `!command`\n' +
                    '**Website:** [rr.sellhub.cx](https://rr.sellhub.cx)'
                )
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 256 }))
                .addFields({ name: '📂 Categories', value:
                    '🎟️ **Tickets** — Manage support tickets\n' +
                    '📊 **Server** — Server info & utilities\n' +
                    '😎 **Emoji** — Steal emojis & stickers\n' +
                    (isS ? '🛡️ **Admin** — Channel management & tools\n🔨 **Staff** — Moderation & member management\n' : '')
                })
                .setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() })
                .setTimestamp(),
            tickets: () => new EmbedBuilder()
                .setColor(ACCENT).setTitle('🎟️ Ticket Commands')
                .setDescription('Manage and interact with the ticket system.')
                .addFields(
                    { name: '`/ticket`', value: 'View your open ticket(s)' },
                    { name: '`/queue`', value: 'See how many tickets are open' },
                    { name: '`/ticketinfo`', value: 'Info about current ticket *(use inside a ticket channel)*' },
                    { name: '`/adduser` `user`', value: 'Add someone to current ticket *(use inside a ticket channel)*' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
            server: () => new EmbedBuilder()
                .setColor(CYAN).setTitle('📊 Server Commands')
                .setDescription('View server info and utilities.')
                .addFields(
                    { name: '`/info`', value: 'Server statistics — members, boosts, creation date and more' },
                    { name: '`/userinfo` `[user]`', value: 'Detailed user profile — roles, join date, account age' },
                    { name: '`/status`', value: 'Bot & server status — uptime, ping, open tickets' },
                    { name: '`/rules`', value: 'Display the server rules' },
                    { name: '`/ping`', value: 'Check bot latency and WebSocket ping' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
            emoji: () => new EmbedBuilder()
                .setColor(0xffcc00).setTitle('😎 Emoji & Sticker Commands')
                .setDescription('Steal emojis and stickers from other servers!')
                .addFields(
                    { name: '`/steal` `emojis`', value: 'Paste emojis into the input field — shows **Steal / Download / Both** buttons' },
                    { name: '`/stealsticker` `[name]`', value: 'Reply to a sticker message first, then run this command' },
                ).setFooter({ text: 'Requires Manage Expressions permission', iconURL: client.user.displayAvatarURL() }),
            admin: () => new EmbedBuilder()
                .setColor(0x9b59b6).setTitle('🛡️ Admin Commands')
                .setDescription('Channel management and administrative tools. Staff only.')
                .addFields(
                    { name: '`/clear` `amount` `filter` `[user]`', value: 'Delete messages — pick amount, filter type, and optionally a specific user' },
                    { name: '`/purge` `amount`', value: 'Quick bulk-delete messages' },
                    { name: '`/say` `message` `[channel]`', value: 'Send an announcement as the bot' },
                    { name: '`/close` `[reason]`', value: 'Close a ticket channel *(use inside a ticket channel)*' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
            staff: () => new EmbedBuilder()
                .setColor(0xff4444).setTitle('🔨 Staff Commands')
                .setDescription('Member moderation and management. Staff only.')
                .addFields(
                    { name: '`/kick` `user` `[reason]`', value: 'Kick a member from the server' },
                    { name: '`/ban` `user` `[reason]`', value: 'Ban a member from the server' },
                    { name: '`/warn` `user` `[reason]`', value: 'Issue a warning — member gets a DM' },
                    { name: '`/warns` `[user]`', value: 'View all warnings for a member' },
                    { name: '`/clearwarns` `user`', value: 'Clear all warnings for a member' },
                ).setFooter({ text: 'RazorReaper Bot | rr.sellhub.cx', iconURL: client.user.displayAvatarURL() }),
        };

        const options = [
            { label: 'Home', description: 'Main help overview', value: 'home', emoji: '⚡' },
            { label: 'Tickets', description: 'Ticket system commands', value: 'tickets', emoji: '🎟️' },
            { label: 'Server', description: 'Server info & utilities', value: 'server', emoji: '📊' },
            { label: 'Emoji & Stickers', description: 'Steal emojis & stickers', value: 'emoji', emoji: '😎' },
        ];
        if (isS) {
            options.push({ label: 'Admin', description: 'Channel management & tools', value: 'admin', emoji: '🛡️' });
            options.push({ label: 'Staff', description: 'Member moderation', value: 'staff', emoji: '🔨' });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`help_slash_${interaction.id}`)
            .setPlaceholder('Select a category...')
            .addOptions(options);

        const reply = await interaction.reply({
            embeds: [helpCategories.home()],
            components: [new ActionRowBuilder().addComponents(selectMenu)],
            fetchReply: true,
        });

        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 120_000 });
        collector.on('collect', async (i) => { const b = helpCategories[i.values[0]]; if (b) await i.update({ embeds: [b()] }); });
        collector.on('end', () => { reply.edit({ components: [] }).catch(() => {}); });
        return;
    }

    // ── /info ─────────────────────────────────────────────────────────────────
    if (commandName === 'info') {
        await guild.fetch();
        const onlineCount = guild.members.cache.filter(m => m.presence?.status === 'online').size;
        const boostTier = guild.premiumTier === 0 ? 'No boost' : `Tier ${guild.premiumTier}`;
        const e = new EmbedBuilder().setColor(ACCENT).setTitle(`⚙️ ${guild.name}`)
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .addFields(
                { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
                { name: '🟢 Online', value: `${onlineCount}`, inline: true },
                { name: '🚀 Boost', value: boostTier, inline: true },
                { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: '🌐 Website', value: '[rr.sellhub.cx](https://rr.sellhub.cx)', inline: true },
            ).setFooter({ text: 'RazorReaper', iconURL: client.user.displayAvatarURL() }).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /userinfo ─────────────────────────────────────────────────────────────
    if (commandName === 'userinfo') {
        const target = interaction.options.getMember('user') || member;
        const roles = target.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
        const topRoles = roles.first(5).map(r => r.toString()).join(' ') || 'None';
        const e = new EmbedBuilder().setColor(CYAN).setTitle(`👤 ${target.user.username}`)
            .setThumbnail(target.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { name: '🆔 User ID', value: target.id, inline: true },
                { name: '📅 Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: '🗓️ Account Age', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: '🏆 Top Role', value: `${target.roles.highest}`, inline: true },
                { name: '🤖 Bot?', value: target.user.bot ? 'Yes' : 'No', inline: true },
                { name: `📋 Roles (${roles.size})`, value: topRoles },
            ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /status ───────────────────────────────────────────────────────────────
    if (commandName === 'status') {
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = Math.floor(uptime % 60);
        const openTickets = guild.channels.cache.filter(c => isTicketChannel(c)).size;
        const e = infoEmbed(null, '📊 RazorReaper Status');
        e.addFields(
            { name: '🤖 Bot', value: 'Online ✅', inline: true },
            { name: '⏱️ Uptime', value: `${h}h ${m}m ${s}s`, inline: true },
            { name: '📡 Ping', value: `${client.ws.ping}ms`, inline: true },
            { name: '🎟️ Open Tickets', value: `${openTickets}`, inline: true },
            { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
            { name: '🌐 Website', value: '[rr.sellhub.cx](https://rr.sellhub.cx)', inline: true },
        ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /rules ────────────────────────────────────────────────────────────────
    if (commandName === 'rules') {
        const e = new EmbedBuilder().setColor(ACCENT).setTitle('📋 RazorReaper — Server Rules')
            .setDescription(
                '**1.** Be respectful to all members.\n**2.** No spam, advertising or self-promotion.\n' +
                '**3.** No NSFW content.\n**4.** No doxxing or sharing personal info.\n' +
                '**5.** Follow Discord\'s Terms of Service.\n**6.** Use channels for their intended purpose.\n' +
                '**7.** All disputes go through the ticket system — do not DM staff.\n\n*Violations may result in a warn, kick or ban.*'
            ).setFooter({ text: 'RazorReaper | rr.sellhub.cx' });
        return interaction.reply({ embeds: [e] });
    }

    // ── /ticket ───────────────────────────────────────────────────────────────
    if (commandName === 'ticket') {
        const userTickets = guild.channels.cache.filter(c => isTicketChannel(c) && c.permissionOverwrites.cache.has(interaction.user.id));
        if (userTickets.size === 0) {
            const createCh = guild.channels.cache.find(c => c.name.includes('create-ticket'));
            return interaction.reply({ embeds: [infoEmbed(`❌ You have no open tickets.\n\nOpen one in ${createCh ? `<#${createCh.id}>` : 'create-ticket'}!`)], ephemeral: true });
        }
        const list = userTickets.map(c => `• ${c} — \`${c.name}\``).join('\n');
        return interaction.reply({ embeds: [infoEmbed(`🎟️ Your open ticket${userTickets.size > 1 ? 's' : ''}:\n${list}`)], ephemeral: true });
    }

    // ── /queue ────────────────────────────────────────────────────────────────
    if (commandName === 'queue') {
        const openTickets = guild.channels.cache.filter(c => isTicketChannel(c));
        const closedTickets = guild.channels.cache.filter(c => c.name.toLowerCase().startsWith('closed-'));
        const e = infoEmbed(null, '🎟️ Ticket Queue');
        e.addFields(
            { name: '🟢 Open Tickets', value: `${openTickets.size}`, inline: true },
            { name: '🔴 Closed Tickets', value: `${closedTickets.size}`, inline: true },
            { name: '📊 Total', value: `${openTickets.size + closedTickets.size}`, inline: true },
        );
        if (isStaff(member) && openTickets.size > 0) {
            e.addFields({ name: '📋 Open Channels', value: openTickets.map(c => `• ${c}`).join('\n').substring(0, 1024) });
        }
        return interaction.reply({ embeds: [e] });
    }

    // ── /ticketinfo ───────────────────────────────────────────────────────────
    if (commandName === 'ticketinfo') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        const perms = channel.permissionOverwrites.cache;
        const ticketOwner = perms.filter(p => p.type === 1 && p.id !== guild.id).find(p => p.allow.has(PermissionsBitField.Flags.ViewChannel));
        const ownerUser = ticketOwner ? await client.users.fetch(ticketOwner.id).catch(() => null) : null;
        const e = infoEmbed(null, `🎟️ Ticket Info — #${channel.name}`);
        e.addFields(
            { name: '📛 Channel', value: `${channel}`, inline: true },
            { name: '👤 Owner', value: ownerUser ? `<@${ownerUser.id}>` : 'Unknown', inline: true },
            { name: '📅 Created', value: `<t:${Math.floor(channel.createdTimestamp / 1000)}:R>`, inline: true },
        ).setTimestamp();
        return interaction.reply({ embeds: [e] });
    }

    // ── /adduser ──────────────────────────────────────────────────────────────
    if (commandName === 'adduser') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        await channel.permissionOverwrites.edit(target, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return interaction.reply({ embeds: [okEmbed(`✅ Added ${target} to this ticket.`)] });
    }

    // ── /close ────────────────────────────────────────────────────────────────
    if (commandName === 'close') {
        if (!isTicketChannel(channel)) return interaction.reply({ embeds: [errEmbed('❌ Use this inside a ticket channel.')], ephemeral: true });
        if (!isStaff(member) && !channel.permissionOverwrites.cache.has(interaction.user.id)) {
            return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        }
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const e = new EmbedBuilder().setColor(0xff4444).setTitle('🔒 Ticket Closing')
            .setDescription(`**Reason:** ${reason}\n\nThis ticket will be closed.`)
            .setFooter({ text: `Closed by ${interaction.user.tag}` }).setTimestamp();
        await interaction.reply({ embeds: [e] });
        const num = channel.name.replace(/[^0-9]/g, '');
        await channel.setName(`closed-${num || '0000'}`).catch(() => {});
        await channel.permissionOverwrites.edit(guild.id, { ViewChannel: false }).catch(() => {});
        return;
    }

    // ── /say ──────────────────────────────────────────────────────────────────
    if (commandName === 'say') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const text = interaction.options.getString('message');
        const targetChannel = interaction.options.getChannel('channel') || channel;
        await targetChannel.send(text);
        return interaction.reply({ embeds: [okEmbed(`✅ Message sent to ${targetChannel}`)], ephemeral: true });
    }

    // ── /clear ────────────────────────────────────────────────────────────────
    if (commandName === 'clear') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const amount = interaction.options.getInteger('amount');
        const filter = interaction.options.getString('filter');
        const targetUser = interaction.options.getUser('user');

        if (filter === 'user' && !targetUser) {
            return interaction.reply({ embeds: [errEmbed('❌ You selected "Specific user" but didn\'t provide a user.\nUse the `user` option.')], ephemeral: true });
        }

        await interaction.reply({ embeds: [infoEmbed('🗑️ Clearing messages...')] });

        let totalDeleted = 0;
        let remaining = amount;

        while (remaining > 0) {
            const fetchAmount = Math.min(remaining, 100);
            const fetched = await channel.messages.fetch({ limit: fetchAmount }).catch(() => null);
            if (!fetched || fetched.size === 0) break;

            let toDelete = fetched;
            if (filter === 'user' && targetUser) toDelete = toDelete.filter(m => m.author.id === targetUser.id);
            else if (filter === 'bots') toDelete = toDelete.filter(m => m.author.bot);

            const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
            toDelete = toDelete.filter(m => m.createdTimestamp > twoWeeksAgo);

            if (toDelete.size === 0) break;
            const deleted = await channel.bulkDelete(toDelete, true).catch(() => null);
            if (!deleted || deleted.size === 0) break;

            totalDeleted += deleted.size;
            remaining -= fetchAmount;
            if (remaining > 0) await new Promise(r => setTimeout(r, 1000));
        }

        let desc = `🗑️ Deleted **${totalDeleted}** messages`;
        if (filter === 'user' && targetUser) desc += ` from ${targetUser}`;
        else if (filter === 'bots') desc += ' from bots';
        desc += ' in this channel.';

        const m = await channel.send({ embeds: [okEmbed(desc)] });
        setTimeout(() => m.delete().catch(() => {}), 5000);
        return;
    }

    // ── /purge ────────────────────────────────────────────────────────────────
    if (commandName === 'purge') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const n = interaction.options.getInteger('amount');
        await interaction.reply({ embeds: [infoEmbed('🗑️ Purging...')], ephemeral: true });
        const deleted = await channel.bulkDelete(n, true).catch(() => null);
        if (!deleted) return interaction.editReply({ embeds: [errEmbed('❌ Cannot delete messages older than 14 days.')] });
        const m = await channel.send({ embeds: [okEmbed(`🗑️ Deleted **${deleted.size}** messages.`)] });
        setTimeout(() => m.delete().catch(() => {}), 3000);
        return;
    }

    // ── /kick ─────────────────────────────────────────────────────────────────
    if (commandName === 'kick') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target.kickable) return interaction.reply({ embeds: [errEmbed('❌ Cannot kick this user.')], ephemeral: true });
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await target.kick(reason);
        return interaction.reply({ embeds: [staffEmbed(`✅ **${target.user.tag}** was kicked.\n**Reason:** ${reason}`, '👢 Member Kicked')] });
    }

    // ── /ban ──────────────────────────────────────────────────────────────────
    if (commandName === 'ban') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target.bannable) return interaction.reply({ embeds: [errEmbed('❌ Cannot ban this user.')], ephemeral: true });
        const reason = interaction.options.getString('reason') || 'No reason provided';
        await target.ban({ reason, deleteMessageSeconds: 86400 });
        return interaction.reply({ embeds: [staffEmbed(`✅ **${target.user.tag}** was banned.\n**Reason:** ${reason}`, '🔨 Member Banned')] });
    }

    // ── /warn ─────────────────────────────────────────────────────────────────
    if (commandName === 'warn') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        if (!warns[target.id]) warns[target.id] = [];
        warns[target.id].push({ reason, mod: interaction.user.tag, time: Date.now() });
        const count = warns[target.id].length;
        target.send({ embeds: [infoEmbed(`⚠️ You received a warning in **${guild.name}**\n**Reason:** ${reason}\n**Total Warnings:** ${count}`)] }).catch(() => {});
        return interaction.reply({ embeds: [staffEmbed(`⚠️ **${target.user.tag}** has been warned.\n**Reason:** ${reason}\n**Total Warnings:** ${count}`, '⚠️ Member Warned')] });
    }

    // ── /warns ────────────────────────────────────────────────────────────────
    if (commandName === 'warns') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user') || member;
        const userWarns = warns[target.id] || [];
        if (userWarns.length === 0) return interaction.reply({ embeds: [infoEmbed(`✅ **${target.user.tag}** has no warnings.`)] });
        const list = userWarns.map((w, i) => `**${i + 1}.** ${w.reason} — *${w.mod}* — <t:${Math.floor(w.time / 1000)}:R>`).join('\n');
        return interaction.reply({ embeds: [staffEmbed(list, `⚠️ Warnings for ${target.user.tag} (${userWarns.length})`)] });
    }

    // ── /clearwarns ───────────────────────────────────────────────────────────
    if (commandName === 'clearwarns') {
        if (!isStaff(member)) return interaction.reply({ embeds: [errEmbed('❌ No permission.')], ephemeral: true });
        const target = interaction.options.getMember('user');
        warns[target.id] = [];
        return interaction.reply({ embeds: [okEmbed(`✅ Cleared all warnings for **${target.user.tag}**.`)] });
    }

    // ── /steal ────────────────────────────────────────────────────────────────
    if (commandName === 'steal') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuildExpressions)) {
            return interaction.reply({ embeds: [errEmbed('❌ You need the **Manage Expressions** permission.')], ephemeral: true });
        }

        const input = interaction.options.getString('emojis');
        const emojiRegex = /<(a?):(\w+):(\d+)>/g;
        const found = [];

        for (const match of input.matchAll(emojiRegex)) {
            found.push({ animated: match[1] === 'a', name: match[2], id: match[3] });
        }

        // Check if it's a raw ID
        if (found.length === 0 && /^\d+$/.test(input.trim())) {
            found.push({ animated: false, name: 'stolen_emoji', id: input.trim(), tryGif: true });
        }

        if (found.length === 0) {
            return interaction.reply({ embeds: [errEmbed('❌ No custom emojis found in your input.\nPaste Discord custom emojis like `:emoji:` into the field.')], ephemeral: true });
        }

        const emojiList = found.map((e, i) => `**${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`).join('\n');

        const previewEmbed = new EmbedBuilder()
            .setColor(CYAN).setTitle('😎 Emoji Stealer — Select & Choose')
            .setDescription(`Found **${found.length}** emoji(s):\n\n${emojiList}`)
            .setFooter({ text: 'Select emojis below, then choose to steal or download. Expires in 60s.' }).setTimestamp();

        const components = [];
        if (found.length > 1) {
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`steal_slash_select_${interaction.id}`)
                .setPlaceholder('Select emojis to steal/download...')
                .setMinValues(1).setMaxValues(found.length)
                .addOptions(found.map((e, i) => ({
                    label: `:${e.name}:`, description: e.animated ? 'Animated emoji' : 'Static emoji',
                    value: String(i), emoji: { id: e.id, animated: e.animated },
                })));
            components.push(new ActionRowBuilder().addComponents(selectMenu));
        }

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`steal_slash_add_${interaction.id}`).setLabel('Steal to Server').setStyle(ButtonStyle.Success).setEmoji('😎'),
            new ButtonBuilder().setCustomId(`steal_slash_dl_${interaction.id}`).setLabel('Download').setStyle(ButtonStyle.Primary).setEmoji('📥'),
            new ButtonBuilder().setCustomId(`steal_slash_both_${interaction.id}`).setLabel('Steal + Download').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
            new ButtonBuilder().setCustomId(`steal_slash_cancel_${interaction.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
        );
        components.push(buttons);

        const reply = await interaction.reply({ embeds: [previewEmbed], components, fetchReply: true });

        let selectedIndices = found.map((_, i) => i);
        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 60_000 });

        collector.on('collect', async (btnInt) => {
            if (btnInt.customId === `steal_slash_select_${interaction.id}`) {
                selectedIndices = btnInt.values.map(Number);
                const updatedList = found.map((e, i) =>
                    `${selectedIndices.includes(i) ? '✅' : '⬜'} **${i + 1}.** \`:${e.name}:\` ${e.animated ? '*(animated)*' : ''}`
                ).join('\n');
                previewEmbed.setDescription(`Found **${found.length}** emoji(s) — **${selectedIndices.length}** selected:\n\n${updatedList}`);
                return btnInt.update({ embeds: [previewEmbed] });
            }
            if (btnInt.customId === `steal_slash_cancel_${interaction.id}`) {
                collector.stop('cancelled');
                return btnInt.update({ embeds: [errEmbed('❌ Cancelled.')], components: [] });
            }

            const doSteal = btnInt.customId.includes('_add_') || btnInt.customId.includes('_both_');
            const doDownload = btnInt.customId.includes('_dl_') || btnInt.customId.includes('_both_');
            await btnInt.deferUpdate();
            collector.stop('acted');

            const selected = selectedIndices.map(i => found[i]);
            const results = [];
            const attachments = [];

            for (const emoji of selected) {
                const ext = emoji.animated ? 'gif' : 'png';
                let url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
                if (doSteal) {
                    try {
                        const created = await guild.emojis.create({ attachment: url, name: emoji.name });
                        results.push(`✅ ${created} \`:${emoji.name}:\` — added to server`);
                    } catch (e) {
                        if (emoji.tryGif) { url = `https://cdn.discordapp.com/emojis/${emoji.id}.gif`; try { const c = await guild.emojis.create({ attachment: url, name: emoji.name }); results.push(`✅ ${c} \`:${emoji.name}:\` — added`); continue; } catch {} }
                        results.push(`❌ \`:${emoji.name}:\` — ${e.message}`);
                    }
                }
                if (doDownload) {
                    attachments.push(new AttachmentBuilder(url, { name: `${emoji.name}.${ext}` }));
                    results.push(`📥 \`:${emoji.name}:\` — file attached`);
                }
            }

            await reply.edit({
                embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('😎 Emoji Steal — Results').setDescription(results.join('\n')).setFooter({ text: `Requested by ${interaction.user.tag}` }).setTimestamp()],
                components: [], files: attachments,
            });
        });

        collector.on('end', (_, reason) => { if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out.')], components: [] }).catch(() => {}); });
        return;
    }

    // ── /stealsticker ─────────────────────────────────────────────────────────
    if (commandName === 'stealsticker') {
        if (!member.permissions.has(PermissionsBitField.Flags.ManageGuildExpressions)) {
            return interaction.reply({ embeds: [errEmbed('❌ You need the **Manage Expressions** permission.')], ephemeral: true });
        }

        // Fetch recent messages to find the latest sticker
        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        const stickerMsg = messages?.find(m => m.stickers.size > 0);
        if (!stickerMsg) {
            return interaction.reply({ embeds: [errEmbed('❌ No sticker found in the last 10 messages.\nSend or find a sticker message first, then use this command.')], ephemeral: true });
        }

        const sticker = stickerMsg.stickers.first();
        const stickerName = interaction.options.getString('name') || sticker.name;

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`sticker_slash_add_${interaction.id}`).setLabel('Steal to Server').setStyle(ButtonStyle.Success).setEmoji('😎'),
            new ButtonBuilder().setCustomId(`sticker_slash_dl_${interaction.id}`).setLabel('Download').setStyle(ButtonStyle.Primary).setEmoji('📥'),
            new ButtonBuilder().setCustomId(`sticker_slash_both_${interaction.id}`).setLabel('Steal + Download').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
            new ButtonBuilder().setCustomId(`sticker_slash_cancel_${interaction.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
        );

        const previewEmbed = new EmbedBuilder().setColor(CYAN).setTitle('🎨 Sticker Stealer')
            .setDescription(`**Sticker:** ${stickerName}\n**Format:** ${sticker.format}`)
            .setThumbnail(sticker.url)
            .setFooter({ text: 'Choose an action below. Expires in 60s.' }).setTimestamp();

        const reply = await interaction.reply({ embeds: [previewEmbed], components: [buttons], fetchReply: true });

        const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: 60_000 });
        collector.on('collect', async (btnInt) => {
            if (btnInt.customId.includes('_cancel_')) { collector.stop('cancelled'); return btnInt.update({ embeds: [errEmbed('❌ Cancelled.')], components: [] }); }
            const doSteal = btnInt.customId.includes('_add_') || btnInt.customId.includes('_both_');
            const doDownload = btnInt.customId.includes('_dl_') || btnInt.customId.includes('_both_');
            await btnInt.deferUpdate(); collector.stop('acted');
            const results = []; const files = [];
            if (doSteal) { try { const c = await guild.stickers.create({ file: sticker.url, name: stickerName, tags: '😀' }); results.push(`✅ Added sticker **${c.name}**!`); } catch (e) { results.push(`❌ ${e.message}`); } }
            if (doDownload) { const ext = sticker.format === 'LOTTIE' ? 'json' : 'png'; files.push(new AttachmentBuilder(sticker.url, { name: `${stickerName}.${ext}` })); results.push('📥 File attached!'); }
            await reply.edit({ embeds: [okEmbed(results.join('\n'))], components: [], files });
        });
        collector.on('end', (_, reason) => { if (reason === 'time') reply.edit({ embeds: [errEmbed('⏰ Timed out.')], components: [] }).catch(() => {}); });
        return;
    }
});

client.login(process.env.TOKEN);
