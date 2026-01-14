const { handleError, commonQuery, Op } = require("../../helpers");
const { Notification, User, sequelize } = require("../../models");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.NOTIFICAION.NAME;

exports.getAll = async (req, res) => {
  try {
    if (!req.body.filter) {
      req.body.filter = {};
    }
    req.body.filter.receiver_id = req.body.user_id;
    const data = await commonQuery.fetchPaginatedData(
      Notification, 
      req.body, 
      [],
      {
        include: [
          { model: User, as: "user", attributes: [] }
        ],
        attributes: [
          "id",
          "title",
          "message",
          "type",
          "is_read",
          "read_at",
          "link",
          "created_at",
          "user.user_name",
        ]
      },
      null,
      true
    );
    return res.success("FETCH", ENTITY, data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.updateReadStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { user_id, notification_ids } = req.body;
    const whereClause = {
      receiver_id: user_id,
    };

    if (Array.isArray(notification_ids) && notification_ids.length > 0) {
      whereClause.id = { [Op.in]: notification_ids };
    } else {
      whereClause.is_read = false;
    }

    const updated = await commonQuery.updateRecordById(
      Notification,
      whereClause,
      {
        is_read: true,
        read_at: new Date(),
      },
      transaction
    );

    await transaction.commit();
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};