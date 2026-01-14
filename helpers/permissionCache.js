const NodeCache = require("node-cache");
const commonQuery = require("../helpers/commonQuery");
const { User, ModuleEntityMaster, ModulePermissionTypeMaster, UserCompanyRoles } = require("../models");

const userCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const entitiesCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const permissionTypesCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

async function getuser(user_id, branch_id, company_id) {
  if (userCache.has(user_id)) {
    return userCache.get(user_id);
  }

  const userData = await commonQuery.findOneRecord(User, 
    {
      id: user_id,
      branch_id,
      company_id,
      status: 0,
    },
    {
      include: [{ model: UserCompanyRoles, as: "ComapanyRole", where: { company_id, branch_id }, attributes: [ "permissions"], required: true } ]
    }
  );

  const plainUser = userData.get({ plain: true });
  plainUser.permission = plainUser.ComapanyRole?.[0]?.permissions ?? plainUser.permission;
  if (plainUser) {
    userCache.set(user_id, plainUser);
  }

  return plainUser;
}

const clearUserCache = (user_id) => {
    userCache.del(user_id);
};

async function getEntity(module_id, entity_id) {
  const key = `${module_id}_${entity_id}`;

//   if (entitiesCache.has(key)) {
//     return entitiesCache.get(key);
//   }

  const entity = await commonQuery.findOneRecord(ModuleEntityMaster, {
    id: entity_id,
    module_id,
    status: 0,
  });

  if (entity) {
    entitiesCache.set(key, entity);
  }

  return entity;
}

const clearEntityCache = (module_id, entity_id) => {
    const key = `${module_id}_${entity_id}`;
    entitiesCache.del(key);
};

async function getPermissionType(permissionName) {
  if (permissionTypesCache.has(permissionName)) {
    return permissionTypesCache.get(permissionName);
  }

  const record = await commonQuery.findOneRecord(ModulePermissionTypeMaster, {
    permission_type_name: permissionName,
  });

  if (record) {
    permissionTypesCache.set(permissionName, record);
  }

  return record;
}

const clearPermissionTypeCache = (permissionName) => {
    permissionTypesCache.del(permissionName);
};

module.exports = {
  getuser,
  clearUserCache,
  getEntity,
  clearEntityCache,
  getPermissionType,
  clearPermissionTypeCache,
};
