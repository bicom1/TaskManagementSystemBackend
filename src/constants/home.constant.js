const DEFAULT_HOME_CARDS = [
  { id: 'recents', enabled: true, order: 0 },
  { id: 'agenda', enabled: true, order: 1 },
  { id: 'meetings', enabled: true, order: 2 },
  { id: 'my_work', enabled: true, order: 3 },
  { id: 'assigned_to_me', enabled: true, order: 4 },
  { id: 'personal_list', enabled: true, order: 5 },
  { id: 'assigned_comments', enabled: true, order: 6 },
  { id: 'priorities', enabled: true, order: 7 },
  { id: 'locations', enabled: true, order: 8 },
  { id: 'ai_standup', enabled: true, order: 9 },
];

const HOME_CARD_META = {
  recents: { label: 'Recents', description: 'Recently opened projects and tasks' },
  agenda: { label: 'Agenda', description: 'Upcoming due dates for your work' },
  meetings: { label: 'Meetings', description: 'Team meetings you are invited to' },
  my_work: { label: 'My Work', description: 'Tasks you are actively working on' },
  assigned_to_me: { label: 'Assigned to me', description: 'Everything assigned to you' },
  personal_list: { label: 'Personal List', description: 'Tasks you starred for yourself' },
  assigned_comments: { label: 'Assigned Comments', description: 'Comments and mentions on your work' },
  priorities: { label: 'Priorities', description: 'High and urgent tasks' },
  locations: { label: 'Locations', description: 'Offices and sites for your teams' },
  ai_standup: { label: 'AI Standup', description: 'Auto summary of your day' },
};

module.exports = { DEFAULT_HOME_CARDS, HOME_CARD_META };
