if(process.env.APP_ENV!=='staging'||!/^staging_ayla_[a-z0-9_]+$/.test(process.env.STAGING_DATABASE_SCHEMA||'')||process.env.PUBLIC_APP_URL?.includes('://privacy-ayla.vercel.app'))throw new Error('Staging payments require isolated staging configuration');
module.exports={...require('./mock-provider'),name:'staging'};
