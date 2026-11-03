export function writeProducerDiscoveryConfiguration(
  destinationDirectory: string,
  storage: {
    signalIngressDescriptorPath: string;
    signalIngressSecretPath: string;
  },
): Promise<void>;
