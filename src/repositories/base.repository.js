class BaseRepository {
  /** @param {import('mongoose').Model} model */
  constructor(model) {
    this.model = model;
  }

  async create(data) {
    return this.model.create(data);
  }

  async findById(id, { populate } = {}) {
    const query = this.model.findById(id);
    if (populate) query.populate(populate);
    return query.exec();
  }

  async findOne(filter, { populate } = {}) {
    const query = this.model.findOne(filter);
    if (populate) query.populate(populate);
    return query.exec();
  }

  /**
   * @param {object} filter
   * @param {{ page?: number, limit?: number, sort?: string, populate?: any }} options
   */
  async findPaginated(filter = {}, { page = 1, limit = 20, sort = '-createdAt', populate } = {}) {
    const skip = (page - 1) * limit;

    const query = this.model.find(filter).sort(sort).skip(skip).limit(limit);
    if (populate) query.populate(populate);

    const [data, total] = await Promise.all([
      query.exec(),
      this.model.countDocuments(filter),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async updateById(id, updates) {
    return this.model
      .findByIdAndUpdate(id, updates, { new: true, runValidators: true })
      .exec();
  }

  async deleteById(id) {
    return this.model.findByIdAndDelete(id).exec();
  }

  async count(filter = {}) {
    return this.model.countDocuments(filter);
  }
}

module.exports = BaseRepository;
