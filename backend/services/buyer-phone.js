// Brazilian mobile identity: country code + DDD + nine-digit mobile number.
module.exports = function phone(value) {
  if (typeof value !== 'string' || !/^[+\d\s()-]{10,25}$/.test(value)) return null;
  let digits=value.replace(/\D/g,'');
  if(digits.length===13 && digits.startsWith('55')) digits=digits.slice(2);
  return /^[1-9]{2}9\d{8}$/.test(digits) ? '55'+digits : null;
};
