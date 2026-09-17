// Transactional email is unavailable until a delivery provider is configured.
// Keep consent optional; never store addresses when no sender exists.
module.exports={available:()=>false,async send(){throw Object.assign(new Error('E-mail transacional indisponível.'),{status:503});}};
