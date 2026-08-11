const BaseRepository = require('./base.repository');
const Team = require('../models/team.model');

class TeamRepository extends BaseRepository {
  constructor() {
    super(Team);
  }

  async addMember(teamId, userId) {
    return this.model
      .findByIdAndUpdate(teamId, { $addToSet: { members: userId } }, { new: true })
      .exec();
  }

  async removeMember(teamId, userId) {
    return this.model
      .findByIdAndUpdate(teamId, { $pull: { members: userId } }, { new: true })
      .exec();
  }
}

module.exports = new TeamRepository();
